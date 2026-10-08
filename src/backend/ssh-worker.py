"""One framed operation over SSH stdin/stdout. No persistent helper installation."""
import base64
from contextlib import contextmanager, ExitStack
import errno
import fcntl
import hashlib
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

MAX_BYTES = 32 * 1024 * 1024
active_process = None
effect = "not-applied"


class OperationError(Exception):
    def __init__(self, code):
        self.code = code


def regular(path, follow=True):
    info = os.stat(path) if follow else os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        raise OperationError("INVALID_FILE_TYPE")
    return info


def fingerprint(path, data, info):
    identity = (os.path.realpath(path), info.st_dev, info.st_ino, info.st_mode,
                info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns,
                info.st_ctime_ns)
    return hashlib.sha256(json.dumps(identity).encode("utf8") + b"\0" + data).hexdigest()


def read_snapshot(path):
    # O_NONBLOCK prevents a raced FIFO from turning a file read into a hang.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OperationError("INVALID_FILE_TYPE")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise OperationError("CONTENT_LIMIT")
        initial = fingerprint(path, data, info)
        if initial != fingerprint(path, data, os.fstat(fd)):
            raise OperationError("CONFLICT")
        return data, initial
    finally:
        os.close(fd)


def version(path):
    try:
        return read_snapshot(path)[1]
    except FileNotFoundError:
        return None


def check_version(path, request):
    if "expected" in request and version(path) != request["expected"]:
        raise OperationError("CONFLICT")


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def interrupted(signum, _frame):
    if active_process is not None:
        try:
            os.killpg(active_process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise OperationError("CANCELLED")


for handled_signal in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(handled_signal, interrupted)


@contextmanager
def locked_directory(parent):
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)

def collect_command(process, timeout):
    """Bound both output streams while draining them; clean up the owned process group."""
    deadline = time.monotonic() + timeout
    output = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    try:
        with selectors.DefaultSelector() as pending:
            for name in output:
                stream = getattr(process, name)
                os.set_blocking(stream.fileno(), False)
                pending.register(stream, selectors.EVENT_READ, name)
            while pending.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise OperationError("TIMEOUT")
                for key, _ in pending.select(remaining):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        pending.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise OperationError("CONTENT_LIMIT")
                    output[key.data].extend(chunk)
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise OperationError("TIMEOUT")
        return output["stdout"], output["stderr"]
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()

def check_copy_destination(destination, source_info, expected):
    """Check the entry itself; never follow a destination symlink or overwrite an alias."""
    try:
        target_info = regular(destination, follow=False)
    except FileNotFoundError:
        if expected is not None:
            raise OperationError("CONFLICT")
        return
    if (source_info.st_dev, source_info.st_ino) == (target_info.st_dev, target_info.st_ino):
        raise OperationError("SAME_FILE")
    if expected is None or fingerprint(destination, b"", target_info) != expected:
        raise OperationError("CONFLICT")
def object_kind(info):
    return ("symlink" if stat.S_ISLNK(info.st_mode) else
            "directory" if stat.S_ISDIR(info.st_mode) else
            "file" if stat.S_ISREG(info.st_mode) else "other")


def resolve_object_parent(directory):
    try:
        return os.path.realpath(directory, strict=True)
    except FileNotFoundError:
        if os.path.lexists(directory):
            raise
        return os.path.join(resolve_object_parent(os.path.dirname(directory)), os.path.basename(directory))


def object_snapshot(path):
    resolved = os.path.join(resolve_object_parent(os.path.dirname(path)), os.path.basename(path))
    entries = []
    def walk(file, relative):
        try:
            info = os.lstat(file)
        except FileNotFoundError:
            if relative:
                raise OperationError("TRANSFER_TARGET_CHANGED")
            return
        kind = object_kind(info)
        entry = {"relativePath": relative, "kind": kind,
                 "revision": fingerprint(file, b"", info),
                 "identity": {"device": str(info.st_dev), "inode": str(info.st_ino)},
                 "mode": stat.S_IMODE(info.st_mode)}
        if kind == "symlink":
            entry["link"] = encoded(os.readlink(os.fsencode(file)))
        entries.append(entry)
        if kind == "directory":
            fd = os.open(file, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                if fingerprint(file, b"", os.fstat(fd)) != entry["revision"]:
                    raise OperationError("TRANSFER_TARGET_CHANGED")
                for name in sorted(os.listdir(fd)):
                    walk(os.path.join(file, name), name if not relative else relative + "/" + name)
                if fingerprint(file, b"", os.lstat(file)) != entry["revision"]:
                    raise OperationError("TRANSFER_TARGET_CHANGED")
            finally:
                os.close(fd)
    walk(resolved, "")
    return {"path": resolved, "entries": entries}


def check_object_revision(path, expected):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if expected is not None:
            raise OperationError("TRANSFER_TARGET_CHANGED")
        return None
    if expected is None or fingerprint(path, b"", info) != expected:
        raise OperationError("TRANSFER_TARGET_CHANGED")
    return info


def make_object_parents(directory):
    # Refuse followed directory links, including a parent changed after controller preflight.
    global effect
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        make_object_parents(os.path.dirname(directory))
        effect = "unknown"
        os.mkdir(directory)
        return
    if not stat.S_ISDIR(info.st_mode):
        raise OperationError("INVALID_FILE_TYPE")
    if os.path.dirname(directory) != directory:
        make_object_parents(os.path.dirname(directory))

def perform(request):
    global effect, active_process
    operation = request["operation"]
    path = request.get("path")
    if operation == "gitIndex":
        return write_git_index(request)
    if operation == "journal":
        source_info = regular(path, follow=False)
        source_revision = fingerprint(path, b"", source_info)
        directory = tempfile.mkdtemp(prefix=".pi-ide-journal-")
        backup = os.path.join(directory, "snapshot")
        complete = False
        try:
            perform({"operation": "copy", "path": path, "destination": backup,
                     "sourceRevision": source_revision, "targetRevision": None})
            info = regular(backup, follow=False)
            revision = fingerprint(backup, b"", info)
            digest = hashlib.sha256()
            fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                if fingerprint(backup, b"", os.fstat(fd)) != revision:
                    raise OperationError("CONFLICT")
            finally:
                os.close(fd)
            if fingerprint(path, b"", regular(path, follow=False)) != source_revision:
                raise OperationError("CONFLICT")
            # Hashing the private bytes must not replace the captured access time.
            os.utime(backup, ns=(source_info.st_atime_ns, source_info.st_mtime_ns))
            revision = fingerprint(backup, b"", regular(backup, follow=False))
            complete = True
            return {"directory": directory, "path": backup, "revision": revision,
                    "sourceRevision": source_revision, "sha256": digest.hexdigest()}
        finally:
            # Only the private backup was changed; the original is always untouched.
            effect = "not-applied"
            if not complete:
                try:
                    os.unlink(backup)
                except FileNotFoundError:
                    pass
                os.rmdir(directory)
    if operation == "journal-release":
        directory = os.path.abspath(path)
        if (os.path.dirname(directory) != tempfile.gettempdir() or
                not os.path.basename(directory).startswith(".pi-ide-journal-")):
            raise OperationError("INVALID_JOURNAL")
        try:
            info = os.lstat(directory)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise OperationError("INVALID_JOURNAL")
        backup = os.path.join(directory, "snapshot")
        try:
            regular(backup, follow=False)
            os.unlink(backup)
        except FileNotFoundError:
            pass
        os.rmdir(directory)
        return None
    if operation == "realpath":
        return os.path.realpath(path, strict=True)
    if operation == "git-query":
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        return git_command(path, request["args"], environment).decode("utf8")
    if operation == "object-snapshot":
        return object_snapshot(path)
    if operation in ("mkdir-object", "symlink-object"):
        info = check_object_revision(path, request["revision"])
        if operation == "mkdir-object" and info is not None:
            if not stat.S_ISDIR(info.st_mode):
                raise OperationError("INVALID_FILE_TYPE")
            return None
        if info is not None:
            raise OperationError("TRANSFER_TARGET_CHANGED")
        make_object_parents(os.path.dirname(path))
        with locked_directory(os.path.dirname(path)):
            check_object_revision(path, None)
            effect = "unknown"
            if operation == "mkdir-object":
                os.mkdir(path, request["mode"] & 0o7777)
            else:
                os.symlink(base64.b64decode(request["link"], validate=True), os.fsencode(path))
            effect = "applied"
        return None
    if operation == "chmod-object":
        make_object_parents(os.path.dirname(path))
        with locked_directory(os.path.dirname(path)):
            info = check_object_revision(path, request["revision"])
            if info is None or not stat.S_ISDIR(info.st_mode):
                raise OperationError("INVALID_FILE_TYPE")
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                if fingerprint(path, b"", os.fstat(fd)) != request["revision"]:
                    raise OperationError("TRANSFER_TARGET_CHANGED")
                effect = "unknown"
                os.fchmod(fd, request["mode"] & 0o7777)
                effect = "applied"
            finally:
                os.close(fd)
        return None
    if operation == "move-object":
        destination = request["destination"]
        if object_snapshot(path) != request["sourceSnapshot"] or object_snapshot(destination) != request["targetSnapshot"]:
            raise OperationError("TRANSFER_TARGET_CHANGED")
        # A same-device rename preserves the entire object, including its inode and link bytes.
        ancestor = os.path.dirname(destination)
        while not os.path.exists(ancestor):
            ancestor = os.path.dirname(ancestor)
        if os.lstat(path).st_dev != os.stat(ancestor).st_dev:
            return False
        make_object_parents(os.path.dirname(destination))
        parents = sorted({os.path.dirname(name) for name in (path, destination)})
        with ExitStack() as locks:
            for parent in parents:
                locks.enter_context(locked_directory(parent))
            if object_snapshot(path) != request["sourceSnapshot"] or object_snapshot(destination) != request["targetSnapshot"]:
                raise OperationError("TRANSFER_TARGET_CHANGED")
            if request["targetSnapshot"]["entries"]:
                effect = "unknown"
                if stat.S_ISDIR(os.lstat(destination).st_mode):
                    if not shutil.rmtree.avoids_symlink_attacks:
                        raise OperationError("DELETE_UNSAFE_PLATFORM")
                    shutil.rmtree(destination)
                else:
                    os.unlink(destination)
            effect = "unknown"
            os.rename(path, destination)
            effect = "applied"
        return True
    if operation == "delete-object":
        # Policy and dialogs run on the controller; verify the same native object here.
        with locked_directory(os.path.dirname(path)):
            info = os.lstat(path)
            if fingerprint(path, b"", info) != request["revision"]:
                raise OperationError("DELETE_TARGET_CHANGED")
            if stat.S_ISDIR(info.st_mode):
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise OperationError("DELETE_UNSAFE_PLATFORM")
                effect = "unknown"
                shutil.rmtree(path)
            elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                effect = "unknown"
                os.unlink(path)
            else:
                raise OperationError("INVALID_FILE_TYPE")
            effect = "applied"
        return None
    if operation == "lstat":
        info = os.lstat(path)
        kind = ("symlink" if stat.S_ISLNK(info.st_mode) else
                "directory" if stat.S_ISDIR(info.st_mode) else
                "file" if stat.S_ISREG(info.st_mode) else "other")
        return {"kind": kind, "size": info.st_size, "mode": stat.S_IMODE(info.st_mode),
                "links": info.st_nlink,
                "identity": {"device": str(info.st_dev), "inode": str(info.st_ino)},
                "revision": fingerprint(path, b"", info)}
    if operation == "stat":
        info = os.stat(path)
        kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "other"
        return {"kind": kind, "size": info.st_size, "mode": stat.S_IMODE(info.st_mode)}
    if operation == "read":
        data, snapshot = read_snapshot(path)
        return {"bytes": encoded(data), "version": snapshot}
    if operation == "range":
        count = request["limit"]
        if count < 0 or count > MAX_BYTES:
            raise OperationError("CONTENT_LIMIT")
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise OperationError("INVALID_FILE_TYPE")
            revision = fingerprint(path, b"", info)
            offset = request["offset"]
            offset = min(info.st_size, max(0, info.st_size + offset if offset < 0 else offset))
            with os.fdopen(fd, "rb", closefd=False) as source:
                source.seek(offset)
                data = source.read(min(count, info.st_size - offset))
            if revision != fingerprint(path, b"", os.fstat(fd)):
                raise OperationError("CONFLICT")
            return {"bytes": encoded(data), "offset": offset, "totalBytes": info.st_size,
                    "revision": revision}
        finally:
            os.close(fd)
    if operation == "list":
        with os.scandir(path) as entries:
            return [{"name": item.name, "kind": "symlink" if item.is_symlink() else "directory" if item.is_dir() else "file" if item.is_file() else "other"} for item in sorted(entries, key=lambda item: item.name)]
    if operation == "write":
        destination = os.path.realpath(path)
        parent = os.path.dirname(destination)
        os.makedirs(parent, exist_ok=True)
        data = base64.b64decode(request["bytes"], validate=True)
        if len(data) > MAX_BYTES:
            raise OperationError("CONTENT_LIMIT")
        with locked_directory(parent):
            existing_fd = None
            temporary = None
            try:
                try:
                    # Retain a locked inode too: linked names may live in different directories.
                    existing_fd = os.open(destination, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    info = os.fstat(existing_fd)
                    if not stat.S_ISREG(info.st_mode):
                        raise OperationError("INVALID_FILE_TYPE")
                    fcntl.flock(existing_fd, fcntl.LOCK_EX)
                    info = os.fstat(existing_fd)
                    if info.st_nlink > 1:
                        # Replacing this inode would disconnect other linked names. This write
                        # is in-place, not atomic; interruption can leave an unknown partial effect.
                        check_version(path, request)
                        effect = "unknown"
                        with os.fdopen(existing_fd, "wb", closefd=False) as target:
                            target.write(data)
                            target.flush()
                            os.ftruncate(existing_fd, len(data))
                            os.fsync(existing_fd)
                        effect = "applied"
                        return fingerprint(path, data, os.fstat(existing_fd))
                    mode = stat.S_IMODE(info.st_mode)
                    owner = (info.st_uid, info.st_gid)
                    attributes = {name: os.getxattr(existing_fd, name) for name in os.listxattr(existing_fd)}
                except FileNotFoundError:
                    mode = 0o666 & ~current_umask()
                    owner = None
                    attributes = {}
                fd, temporary = tempfile.mkstemp(prefix=".pi-ide-", dir=parent)
                with os.fdopen(fd, "wb") as target:
                    target.write(data)
                    target.flush()
                    if owner is not None:
                        os.fchown(target.fileno(), *owner)
                    os.fchmod(target.fileno(), mode)
                    # Preserve ACLs and other extended metadata before replacing the source.
                    # If an attribute cannot be preserved, fail without replacing the original.
                    for name, value in attributes.items():
                        os.setxattr(target.fileno(), name, value)
                    os.fsync(target.fileno())
                check_version(path, request)
                effect = "unknown"
                os.replace(temporary, destination)
                temporary = None
                effect = "applied"
                return fingerprint(path, data, os.stat(destination))
            finally:
                if existing_fd is not None:
                    os.close(existing_fd)
                if temporary is not None:
                    os.unlink(temporary)
    if operation in ("copy", "restore", "move"):
        # Refuse known conflicts before creating any missing parent directory.
        source_info = regular(path, follow=False)
        if fingerprint(path, b"", source_info) != request["sourceRevision"]:
            raise OperationError("CONFLICT")
        check_copy_destination(request["destination"], source_info, request["targetRevision"])
        os.makedirs(os.path.dirname(request["destination"]), exist_ok=True)
    if operation in ("copy", "restore"):
        destination = request["destination"]
        parents = sorted({os.path.realpath(os.path.dirname(name)) for name in (path, destination)})
        with ExitStack() as locks:
            for parent in parents:
                locks.enter_context(locked_directory(parent))
            source_info = regular(path, follow=False)
            if fingerprint(path, b"", source_info) != request["sourceRevision"]:
                raise OperationError("CONFLICT")
            check_copy_destination(destination, source_info, request["targetRevision"])
            source_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            temporary = None
            try:
                opened_info = os.fstat(source_fd)
                if fingerprint(path, b"", opened_info) != request["sourceRevision"]:
                    raise OperationError("CONFLICT")
                attributes = {name: os.getxattr(source_fd, name) for name in os.listxattr(source_fd)}
                target_fd, temporary = tempfile.mkstemp(prefix=".pi-ide-", dir=os.path.dirname(destination))
                with os.fdopen(target_fd, "wb") as target:
                    while True:
                        chunk = os.read(source_fd, 1024 * 1024)
                        if not chunk:
                            break
                        target.write(chunk)
                    target.flush()
                    os.fchmod(target.fileno(), stat.S_IMODE(opened_info.st_mode))
                    for name, value in attributes.items():
                        os.setxattr(target.fileno(), name, value)
                    os.utime(target.fileno(), ns=(opened_info.st_atime_ns, opened_info.st_mtime_ns))
                    os.fsync(target.fileno())
                if (fingerprint(path, b"", os.fstat(source_fd)) != request["sourceRevision"] or
                        fingerprint(path, b"", regular(path, follow=False)) != request["sourceRevision"]):
                    raise OperationError("CONFLICT")
                if operation == "restore" and os.path.exists(destination) and regular(destination, follow=False).st_nlink > 1:
                    linked_fd = os.open(destination, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    try:
                        fcntl.flock(linked_fd, fcntl.LOCK_EX)
                        linked_info = os.fstat(linked_fd)
                        if (fingerprint(destination, b"", linked_info) != request["targetRevision"] or
                                fingerprint(destination, b"", regular(destination, follow=False)) != request["targetRevision"]):
                            raise OperationError("CONFLICT")
                        with open(temporary, "rb") as staged, os.fdopen(linked_fd, "wb", closefd=False) as target:
                            effect = "unknown"
                            while True:
                                chunk = staged.read(1024 * 1024)
                                if not chunk:
                                    break
                                target.write(chunk)
                            target.flush()
                            os.ftruncate(linked_fd, opened_info.st_size)
                            os.fchmod(linked_fd, stat.S_IMODE(opened_info.st_mode))
                            for name in os.listxattr(linked_fd):
                                if name not in attributes:
                                    os.removexattr(linked_fd, name)
                            for name, value in attributes.items():
                                os.setxattr(linked_fd, name, value)
                            os.utime(linked_fd, ns=(opened_info.st_atime_ns, opened_info.st_mtime_ns))
                            os.fsync(linked_fd)
                        effect = "applied"
                        return None
                    finally:
                        os.close(linked_fd)
                check_copy_destination(destination, opened_info, request["targetRevision"])
                effect = "unknown"
                os.replace(temporary, destination)
                temporary = None
                effect = "applied"
                return None
            finally:
                os.close(source_fd)
                if temporary is not None:
                    os.unlink(temporary)
    if operation == "move":
        destination = request["destination"]
        parents = sorted({os.path.realpath(os.path.dirname(name)) for name in (path, destination)})
        with ExitStack() as locks:
            for parent in parents:
                locks.enter_context(locked_directory(parent))
            source_info = regular(path, follow=False)
            if fingerprint(path, b"", source_info) != request["sourceRevision"]:
                raise OperationError("CONFLICT")
            check_copy_destination(destination, source_info, request["targetRevision"])
            effect = "unknown"
            try:
                os.replace(path, destination)
            except OSError as error:
                effect = "not-applied"
                if error.errno != errno.EXDEV:
                    raise
            else:
                effect = "applied"
                return None
        perform({**request, "operation": "copy"})
        # The destination is already published: failed removal is a partial move.
        effect = "unknown"
        return perform({"operation": "unlink", "path": path, "revision": request["sourceRevision"]})
    if operation == "unlink":
        with locked_directory(os.path.dirname(path)):
            info = regular(path, follow=False)
            if fingerprint(path, b"", info) != request["revision"]:
                raise OperationError("CONFLICT")
            effect = "unknown"
            os.unlink(path)
            effect = "applied"
        return None
    if operation == "remove":
        regular(path, follow=False)
        parent = os.path.dirname(path)
        with locked_directory(parent):
            regular(path, follow=False)
            check_version(path, request)
            effect = "unknown"
            os.unlink(path)
            effect = "applied"
        return None
    raise OperationError("UNSUPPORTED_OPERATION")


def git_command(cwd, args, environment=None):
    """Run Git with the same bounded output and owned-process cleanup as other commands."""
    global active_process
    active_process = subprocess.Popen(["git", *args], cwd=cwd, env=environment,
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, _stderr = collect_command(active_process, 30)
        if active_process.returncode != 0:
            raise OperationError("GIT_OPERATION_FAILED")
        return stdout
    finally:
        active_process = None


def git_index_revision(index):
    """Keep a missing index distinct from an existing empty index."""
    try:
        return fingerprint(index, b"", regular(index, follow=False))
    except FileNotFoundError:
        return None


def write_git_index(request):
    """Hold Git's index lock, validate its entry and HEAD, then publish a private index."""
    global effect
    cwd = request["path"]
    repo_path = request["repositoryPath"]
    if (not repo_path or os.path.isabs(repo_path) or ".." in repo_path.split("/") or
            request["mode"] not in ("100644", "100755")):
        raise OperationError("INVALID_GIT_PATH")
    index = git_command(cwd, ["rev-parse", "--git-path", "index"]).decode("utf8").strip()
    index = os.path.abspath(os.path.join(cwd, index))
    lock = index + ".lock"
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    directory = None
    try:
        if git_command(cwd, ["rev-parse", "HEAD"]).decode("ascii").strip() != request["expectedHead"]:
            raise OperationError("GIT_HEAD_CHANGED")
        entries = git_command(cwd, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", repo_path]).split(b"\0")
        entries = [entry for entry in entries if entry]
        if request.get("expectedIndexExists", True):
            if len(entries) != 1:
                raise OperationError("GIT_INDEX_CHANGED")
            metadata, name = entries[0].split(b"\t", 1)
            mode, blob, stage = metadata.decode("ascii").split(" ")
            if name.decode("utf8") != repo_path or stage != "0" or mode != request["expectedIndexMode"]:
                raise OperationError("GIT_INDEX_CHANGED")
            size = int(git_command(cwd, ["cat-file", "-s", blob]))
            if size > MAX_BYTES:
                raise OperationError("CONTENT_LIMIT")
            if hashlib.sha256(git_command(cwd, ["cat-file", "blob", blob])).hexdigest() != request["expectedIndexHash"]:
                raise OperationError("GIT_INDEX_CHANGED")
        elif entries:
            raise OperationError("GIT_INDEX_CHANGED")
        check_git_worktree(cwd, repo_path, request)
        original_revision = git_index_revision(index)
        original_mode = stat.S_IMODE(os.stat(index).st_mode) if original_revision is not None else 0o666 & ~current_umask()
        directory = tempfile.mkdtemp(prefix=".pi-ide-git-", dir=os.path.dirname(index))
        staged_index = os.path.join(directory, "index")
        if original_revision is not None:
            with open(index, "rb") as original, open(staged_index, "wb") as staged:
                while True:
                    chunk = original.read(1024 * 1024)
                    if not chunk:
                        break
                    staged.write(chunk)
                os.fchmod(staged.fileno(), original_mode)
        content = os.path.join(directory, "content")
        with open(content, "wb") as staged:
            data = base64.b64decode(request["bytes"], validate=True)
            if len(data) > MAX_BYTES:
                raise OperationError("CONTENT_LIMIT")
            staged.write(data)
        next_blob = git_command(cwd, ["hash-object", "-w", "--path=" + repo_path, content]).decode("ascii").strip()
        environment = {**os.environ, "GIT_INDEX_FILE": staged_index}
        git_command(cwd, ["update-index", "--add", "--cacheinfo", request["mode"], next_blob, repo_path], environment)
        if (git_command(cwd, ["rev-parse", "HEAD"]).decode("ascii").strip() != request["expectedHead"] or
                git_index_revision(index) != original_revision):
            raise OperationError("GIT_INDEX_CHANGED")
        check_git_worktree(cwd, repo_path, request)
        with open(staged_index, "rb") as staged:
            os.fchmod(staged.fileno(), original_mode)
            os.fsync(staged.fileno())
        effect = "unknown"
        os.replace(staged_index, index)
        effect = "applied"
        return None
    finally:
        os.close(fd)
        os.unlink(lock)
        if directory is not None:
            for name in os.listdir(directory):
                os.unlink(os.path.join(directory, name))
            os.rmdir(directory)


def check_git_worktree(cwd, repo_path, request):
    if "expectedWorktreeHash" in request:
        data, _revision = read_snapshot(os.path.join(cwd, repo_path))
        if hashlib.sha256(data).hexdigest() != request["expectedWorktreeHash"]:
            raise OperationError("GIT_WORKTREE_CHANGED")


def current_umask():
    mask = os.umask(0)
    os.umask(mask)
    return mask


try:
    request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))
    data = perform(request)
    reply = {"ok": True, "data": data}
except OperationError as error:
    reply = {"ok": False, "code": error.code, "effect": effect}
except OSError as error:
    reply = {"ok": False, "code": errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED"), "effect": effect}
except Exception:
    reply = {"ok": False, "code": "REMOTE_OPERATION_FAILED", "effect": effect}
print(json.dumps(reply, ensure_ascii=True), flush=True)
