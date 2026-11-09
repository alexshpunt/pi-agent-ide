"""Windows file operations. Paths arrive as `/C:/...` and leave in the same form.

Identity is the NTFS file index and volume serial. Writers are serialized with named mutexes,
files are replaced with ReplaceFileW, and links and junctions are handled as links, never
followed. Git queries and the guarded index write run the target's own Git.
"""
import base64
from contextlib import ExitStack
import errno
import hashlib
import os
import stat
import subprocess
import tempfile

import ssh_windows_files as win
from ssh_windows_files import (Failure, attributes, error_code, fingerprint, kind_of, native,
                               posix_mode, wire)
from ssh_worker_common import MAX_BYTES, OperationError, encoded

effect = "not-applied"
CHUNK = 1024 * 1024


def git_command(cwd, args, environment=None):
    """Run Git with bounded output. The channel's Job Object owns the process tree."""
    try:
        result = subprocess.run(["git", *args], cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
                                creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise OperationError("TIMEOUT")
    if len(result.stdout) + len(result.stderr) > MAX_BYTES:
        raise OperationError("CONTENT_LIMIT")
    if result.returncode != 0:
        raise OperationError("GIT_OPERATION_FAILED")
    return result.stdout


def git_environment():
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    return environment


def git_index_revision(index):
    """Keep a missing index distinct from an existing empty index."""
    try:
        return fingerprint(index, b"", os.lstat(index))
    except FileNotFoundError:
        return None


def check_git_worktree(cwd, repo_path, request):
    if "expectedWorktreeHash" in request:
        data, _revision = read_snapshot(os.path.join(cwd, repo_path))
        if hashlib.sha256(data).hexdigest() != request["expectedWorktreeHash"]:
            raise OperationError("GIT_WORKTREE_CHANGED")


def write_git_index(request, cwd):
    """Hold Git's index lock, validate its entry and HEAD, then publish a private index."""
    global effect
    repo_path = request["repositoryPath"]
    if (not repo_path or repo_path.startswith("/") or ".." in repo_path.split("/") or
            ":" in repo_path or "\\" in repo_path or request["mode"] not in ("100644", "100755")):
        raise OperationError("INVALID_GIT_PATH")
    index = git_command(cwd, ["rev-parse", "--git-path", "index"]).decode("utf8").strip()
    index = os.path.abspath(os.path.join(cwd, index))
    lock = index + ".lock"
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_BINARY, 0o600)
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
            if int(git_command(cwd, ["cat-file", "-s", blob])) > MAX_BYTES:
                raise OperationError("CONTENT_LIMIT")
            if hashlib.sha256(git_command(cwd, ["cat-file", "blob", blob])).hexdigest() != request["expectedIndexHash"]:
                raise OperationError("GIT_INDEX_CHANGED")
        elif entries:
            raise OperationError("GIT_INDEX_CHANGED")
        check_git_worktree(cwd, repo_path, request)
        original_revision = git_index_revision(index)
        directory = tempfile.mkdtemp(prefix=".pi-ide-git-", dir=os.path.dirname(index))
        staged_index = os.path.join(directory, "index")
        if original_revision is not None:
            with open(index, "rb") as original, open(staged_index, "wb") as staged:
                while True:
                    chunk = original.read(1024 * 1024)
                    if not chunk:
                        break
                    staged.write(chunk)
        content = os.path.join(directory, "content")
        data = base64.b64decode(request["bytes"], validate=True)
        if len(data) > MAX_BYTES:
            raise OperationError("CONTENT_LIMIT")
        with open(content, "wb") as staged:
            staged.write(data)
        # `--path` applies the repository's line-ending conversion to the staged text.
        next_blob = git_command(cwd, ["hash-object", "-w", "--path=" + repo_path, content]).decode("ascii").strip()
        environment = {**os.environ, "GIT_INDEX_FILE": staged_index}
        git_command(cwd, ["update-index", "--add", "--cacheinfo", request["mode"], next_blob, repo_path], environment)
        if (git_command(cwd, ["rev-parse", "HEAD"]).decode("ascii").strip() != request["expectedHead"] or
                git_index_revision(index) != original_revision):
            raise OperationError("GIT_INDEX_CHANGED")
        check_git_worktree(cwd, repo_path, request)
        with open(staged_index, "r+b") as staged:
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


def regular(path, follow=True):
    info = os.stat(path) if follow else os.lstat(path)
    if kind_of(info) != "file":
        raise OperationError("INVALID_FILE_TYPE")
    return info


def read_open(source, count):
    """Read from an open file. Access was granted at open, so a refusal here is a locked range."""
    try:
        return source.read(count)
    except PermissionError:
        raise OperationError("FILE_IN_USE")


def read_snapshot(path):
    fd = os.open(path, os.O_RDONLY | os.O_BINARY)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OperationError("INVALID_FILE_TYPE")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = read_open(source, MAX_BYTES + 1)
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


def mutate(action, *args):
    """Run one filesystem change. A refusal such as a file in use leaves everything as it was."""
    global effect
    effect = "unknown"
    try:
        result = action(*args)
    except OSError:
        effect = "not-applied"
        raise
    effect = "applied"
    return result


def publishing(temporary, destination):
    global effect
    effect = "unknown"
    try:
        win.publish(temporary, destination)
    except Failure as failure:
        effect = failure.effect or "unknown"
        raise OperationError(failure.code)
    effect = "applied"


def check_copy_destination(destination, source_info, expected, alias=False):
    """Check the entry itself; never follow a destination link or overwrite an alias."""
    try:
        target_info = os.lstat(destination)
    except FileNotFoundError:
        if expected is not None:
            raise OperationError("CONFLICT")
        return
    if kind_of(target_info) != "file":
        raise OperationError("INVALID_FILE_TYPE")
    if (source_info.st_dev, source_info.st_ino) == (target_info.st_dev, target_info.st_ino) and not alias:
        raise OperationError("SAME_FILE")
    if expected is None or fingerprint(destination, b"", target_info) != expected:
        raise OperationError("CONFLICT")


def case_only(path, destination):
    """Two spellings of one name: a rename that only changes letter case."""
    return path != destination and os.path.normcase(path) == os.path.normcase(destination)


def resolve_object_parent(directory):
    try:
        return os.path.realpath(directory, strict=True)
    except FileNotFoundError:
        parent = os.path.dirname(directory)
        if os.path.lexists(directory) or parent == directory:
            raise
        return os.path.join(resolve_object_parent(parent), os.path.basename(directory))


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
        kind = kind_of(info)
        entry = {"relativePath": relative, "kind": kind,
                 "revision": fingerprint(file, b"", info),
                 "identity": {"device": str(info.st_dev), "inode": str(info.st_ino)},
                 "mode": posix_mode(info)}
        if kind == "symlink":
            entry["link"] = encoded(os.fsencode(win.link_text(file)))
        entries.append(entry)
        if kind == "directory":
            names = sorted(os.listdir(file))
            if fingerprint(file, b"", os.lstat(file)) != entry["revision"]:
                raise OperationError("TRANSFER_TARGET_CHANGED")
            for name in names:
                walk(os.path.join(file, name), name if not relative else relative + "/" + name)
            if fingerprint(file, b"", os.lstat(file)) != entry["revision"]:
                raise OperationError("TRANSFER_TARGET_CHANGED")

    walk(resolved, "")
    return {"path": wire(resolved), "entries": entries}


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
    parent = os.path.dirname(directory)
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        if parent == directory:
            raise
        make_object_parents(parent)
        effect = "unknown"
        os.mkdir(directory)
        return
    if kind_of(info) != "directory":
        raise OperationError("INVALID_FILE_TYPE")
    if parent != directory:
        make_object_parents(parent)


def remove_object(path, info):
    if kind_of(info) == "directory":
        win.remove_tree(path)
    else:
        win.force_unlink(path, info)


def copy_stream(source, target):
    while True:
        chunk = source.read(CHUNK)
        if not chunk:
            break
        target.write(chunk)


def copy_file(operation, request, path, destination):
    """Copy or restore one regular file through a staged file beside the destination."""
    global effect
    source_info = regular(path, follow=False)
    if fingerprint(path, b"", source_info) != request["sourceRevision"]:
        raise OperationError("CONFLICT")
    check_copy_destination(destination, source_info, request["targetRevision"])
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    keys = {win.lock_key(os.path.dirname(name)) for name in (path, destination)}
    with win.locked(*keys):
        source_info = regular(path, follow=False)
        if fingerprint(path, b"", source_info) != request["sourceRevision"]:
            raise OperationError("CONFLICT")
        check_copy_destination(destination, source_info, request["targetRevision"])
        source_fd = os.open(path, os.O_RDONLY | os.O_BINARY)
        temporary = None
        try:
            opened = os.fstat(source_fd)
            if fingerprint(path, b"", opened) != request["sourceRevision"]:
                raise OperationError("CONFLICT")
            target_fd, temporary = tempfile.mkstemp(prefix=".pi-ide-", dir=os.path.dirname(destination))
            with os.fdopen(target_fd, "wb") as target, os.fdopen(source_fd, "rb", closefd=False) as source:
                copy_stream(source, target)
                target.flush()
                os.fsync(target.fileno())
            os.utime(temporary, ns=(opened.st_atime_ns, opened.st_mtime_ns))
            win.set_attributes(temporary, attributes(opened) & (win.COPIED_ATTRIBUTES | win.FILE_ATTRIBUTE_READONLY))
            if (fingerprint(path, b"", os.fstat(source_fd)) != request["sourceRevision"] or
                    fingerprint(path, b"", regular(path, follow=False)) != request["sourceRevision"]):
                raise OperationError("CONFLICT")
            if operation == "restore" and os.path.lexists(destination):
                linked = regular(destination, follow=False)
                if linked.st_nlink > 1:
                    restore_linked(destination, temporary, opened, request["targetRevision"])
                    return None
            check_copy_destination(destination, opened, request["targetRevision"])
            publishing(temporary, destination)
            temporary = None
            return None
        finally:
            os.close(source_fd)
            if temporary is not None:
                win.discard(temporary)


def restore_linked(destination, staged_path, source_info, expected):
    """Rewrite a hard-linked destination in place so every linked name keeps its identity."""
    global effect
    with win.locked(win.identity_key(os.lstat(destination))):
        with open(destination, "r+b") as linked:
            info = os.fstat(linked.fileno())
            if (fingerprint(destination, b"", info) != expected or
                    fingerprint(destination, b"", regular(destination, follow=False)) != expected):
                raise OperationError("CONFLICT")
            effect = "unknown"
            with open(staged_path, "rb") as staged:
                copy_stream(staged, linked)
            linked.flush()
            linked.truncate(source_info.st_size)
            os.fsync(linked.fileno())
        os.utime(destination, ns=(source_info.st_atime_ns, source_info.st_mtime_ns))
        effect = "applied"


def write_file(path, request):
    global effect
    destination = os.path.realpath(path)
    parent = os.path.dirname(destination)
    os.makedirs(parent, exist_ok=True)
    data = base64.b64decode(request["bytes"], validate=True)
    if len(data) > MAX_BYTES:
        raise OperationError("CONTENT_LIMIT")
    with ExitStack() as locks:
        locks.enter_context(win.locked(win.lock_key(parent)))
        existing = None
        try:
            existing = os.stat(destination)
        except FileNotFoundError:
            pass
        if existing is not None:
            if kind_of(existing) != "file":
                raise OperationError("INVALID_FILE_TYPE")
            locks.enter_context(win.locked(win.identity_key(existing)))
            existing = regular(destination)
            if attributes(existing) & win.FILE_ATTRIBUTE_READONLY:
                raise OperationError("FILE_READ_ONLY")
            if existing.st_nlink > 1:
                # Replacing this file would disconnect its other names. The write is in place,
                # not atomic; interruption can leave an unknown partial effect.
                with open(destination, "r+b") as target:
                    check_version(path, request)
                    effect = "unknown"
                    target.write(data)
                    target.truncate(len(data))
                    target.flush()
                    os.fsync(target.fileno())
                effect = "applied"
                return fingerprint(path, data, os.stat(destination))
        fd, temporary = tempfile.mkstemp(prefix=".pi-ide-", dir=parent)
        try:
            with os.fdopen(fd, "wb") as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            check_version(path, request)
            publishing(temporary, destination)
            temporary = None
            return fingerprint(path, data, os.stat(destination))
        finally:
            if temporary is not None:
                win.discard(temporary)


def journal(path):
    global effect
    source_info = regular(path, follow=False)
    source_revision = fingerprint(path, b"", source_info)
    directory = tempfile.mkdtemp(prefix=".pi-ide-journal-")
    backup = os.path.join(directory, "snapshot")
    complete = False
    try:
        operate({"operation": "copy", "path": wire(path), "destination": wire(backup),
                 "sourceRevision": source_revision, "targetRevision": None})
        info = regular(backup, follow=False)
        revision = fingerprint(backup, b"", info)
        digest = hashlib.sha256()
        fd = os.open(backup, os.O_RDONLY | os.O_BINARY)
        try:
            while True:
                chunk = os.read(fd, CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
            if fingerprint(backup, b"", os.fstat(fd)) != revision:
                raise OperationError("CONFLICT")
        finally:
            os.close(fd)
        if fingerprint(path, b"", regular(path, follow=False)) != source_revision:
            raise OperationError("CONFLICT")
        revision = fingerprint(backup, b"", regular(backup, follow=False))
        complete = True
        return {"directory": wire(directory), "path": wire(backup), "revision": revision,
                "sourceRevision": source_revision, "sha256": digest.hexdigest()}
    finally:
        # Only the private backup was changed; the original is always untouched.
        effect = "not-applied"
        if not complete:
            win.discard(backup)
            try:
                os.rmdir(directory)
            except OSError:
                pass


def journal_release(path):
    directory = os.path.abspath(path)
    if (os.path.normcase(os.path.dirname(directory)) != os.path.normcase(tempfile.gettempdir()) or
            not os.path.basename(directory).startswith(".pi-ide-journal-")):
        raise OperationError("INVALID_JOURNAL")
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return None
    if kind_of(info) != "directory":
        raise OperationError("INVALID_JOURNAL")
    backup = os.path.join(directory, "snapshot")
    try:
        regular(backup, follow=False)
        win.force_unlink(backup)
    except FileNotFoundError:
        pass
    os.rmdir(directory)
    return None


def perform(request):
    global effect
    try:
        return operate(request)
    except Failure as failure:
        effect = failure.effect or effect
        raise OperationError(failure.code)


def operate(request):
    global effect
    operation = request["operation"]
    path = native(request["path"]) if isinstance(request.get("path"), str) else None
    if operation == "gitIndex" and path is not None:
        return write_git_index(request, path)
    if operation == "git-query" and path is not None:
        return git_command(path, request["args"], git_environment()).decode("utf8")
    if operation == "temporary-environment":
        agent = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
        result = {"home": wire(os.path.expanduser("~")), "temporary": wire(tempfile.gettempdir())}
        if agent:
            result["agentDirectory"] = wire(os.path.abspath(agent))
        return result
    if path is None:
        raise OperationError("INVALID_REQUEST")
    if operation == "journal":
        return journal(path)
    if operation == "journal-release":
        return journal_release(path)
    if operation == "realpath":
        return wire(os.path.realpath(path, strict=True))
    if operation == "object-snapshot":
        return object_snapshot(path)
    if operation in ("mkdir-object", "symlink-object"):
        info = check_object_revision(path, request["revision"])
        if operation == "mkdir-object" and info is not None:
            if kind_of(info) != "directory":
                raise OperationError("INVALID_FILE_TYPE")
            return None
        if info is not None:
            raise OperationError("TRANSFER_TARGET_CHANGED")
        make_object_parents(os.path.dirname(path))
        with win.locked(win.lock_key(os.path.dirname(path))):
            check_object_revision(path, None)
            if operation == "mkdir-object":
                mutate(os.mkdir, path)
            else:
                # Links from a POSIX source use `/`; Windows links use `\`.
                link = os.fsdecode(base64.b64decode(request["link"], validate=True)).replace("/", "\\")
                to_directory = os.path.isdir(os.path.join(os.path.dirname(path), link))
                mutate(lambda: os.symlink(link, path, target_is_directory=to_directory))
        return None
    if operation == "chmod-object":
        # Windows has no POSIX mode to publish; keep the identity check the other platforms make.
        make_object_parents(os.path.dirname(path))
        with win.locked(win.lock_key(os.path.dirname(path))):
            info = check_object_revision(path, request["revision"])
            if info is None or kind_of(info) != "directory":
                raise OperationError("INVALID_FILE_TYPE")
        return None
    if operation == "move-object":
        return move_object(path, native(request["destination"]), request)
    if operation == "delete-object":
        # Policy and dialogs run on the controller; verify the same native object here.
        with win.locked(win.lock_key(os.path.dirname(path))):
            info = os.lstat(path)
            if fingerprint(path, b"", info) != request["revision"]:
                raise OperationError("DELETE_TARGET_CHANGED")
            if kind_of(info) not in ("directory", "file", "symlink"):
                raise OperationError("INVALID_FILE_TYPE")
            if kind_of(info) == "directory":
                effect = "unknown"
                win.remove_tree(path)
                effect = "applied"
            else:
                mutate(win.force_unlink, path, info)
        return None
    if operation == "lstat":
        info = os.lstat(path)
        return {"kind": kind_of(info), "size": info.st_size, "mode": posix_mode(info),
                "links": info.st_nlink,
                "identity": {"device": str(info.st_dev), "inode": str(info.st_ino)},
                "revision": fingerprint(path, b"", info)}
    if operation == "stat":
        info = os.stat(path)
        kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "other"
        return {"kind": kind, "size": info.st_size, "mode": posix_mode(info)}
    if operation == "read":
        data, snapshot = read_snapshot(path)
        return {"bytes": encoded(data), "version": snapshot}
    if operation == "range":
        count = request["limit"]
        if count < 0 or count > MAX_BYTES:
            raise OperationError("CONTENT_LIMIT")
        fd = os.open(path, os.O_RDONLY | os.O_BINARY)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise OperationError("INVALID_FILE_TYPE")
            revision = fingerprint(path, b"", info)
            offset = request["offset"]
            offset = min(info.st_size, max(0, info.st_size + offset if offset < 0 else offset))
            with os.fdopen(fd, "rb", closefd=False) as source:
                source.seek(offset)
                data = read_open(source, min(count, info.st_size - offset))
            if revision != fingerprint(path, b"", os.fstat(fd)):
                raise OperationError("CONFLICT")
            return {"bytes": encoded(data), "offset": offset, "totalBytes": info.st_size,
                    "revision": revision}
        finally:
            os.close(fd)
    if operation == "list":
        with os.scandir(path) as entries:
            return [{"name": item.name, "kind": kind_of(item.stat(follow_symlinks=False))}
                    for item in sorted(entries, key=lambda item: item.name)]
    if operation == "write":
        return write_file(path, request)
    if operation in ("copy", "restore"):
        return copy_file(operation, request, path, native(request["destination"]))
    if operation == "move":
        return move_file(path, native(request["destination"]), request)
    if operation == "unlink":
        with win.locked(win.lock_key(os.path.dirname(path))):
            info = regular(path, follow=False)
            if fingerprint(path, b"", info) != request["revision"]:
                raise OperationError("CONFLICT")
            mutate(win.force_unlink, path, info)
        return None
    if operation == "remove":
        regular(path, follow=False)
        with win.locked(win.lock_key(os.path.dirname(path))):
            info = regular(path, follow=False)
            check_version(path, request)
            mutate(win.force_unlink, path, info)
        return None
    raise OperationError("CAPABILITY_UNAVAILABLE")


def move_file(path, destination, request):
    global effect
    source_info = regular(path, follow=False)
    if fingerprint(path, b"", source_info) != request["sourceRevision"]:
        raise OperationError("CONFLICT")
    alias = case_only(path, destination)
    check_copy_destination(destination, source_info, request["targetRevision"], alias)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    keys = {win.lock_key(os.path.dirname(name)) for name in (path, destination)}
    with win.locked(*keys):
        source_info = regular(path, follow=False)
        if fingerprint(path, b"", source_info) != request["sourceRevision"]:
            raise OperationError("CONFLICT")
        check_copy_destination(destination, source_info, request["targetRevision"], alias)
        effect = "unknown"
        try:
            # A rename that only changes case must not go through replace-existing.
            (os.rename if alias else os.replace)(path, destination)
        except OSError as error:
            effect = "not-applied"
            if error.errno != errno.EXDEV:
                raise
        else:
            effect = "applied"
            return None
    operate({**request, "operation": "copy", "path": wire(path), "destination": wire(destination)})
    # The destination is already published: failed removal is a partial move.
    effect = "unknown"
    return operate({"operation": "unlink", "path": wire(path), "revision": request["sourceRevision"]})


def move_object(path, destination, request):
    global effect
    if (object_snapshot(path) != request["sourceSnapshot"] or
            object_snapshot(destination) != request["targetSnapshot"]):
        raise OperationError("TRANSFER_TARGET_CHANGED")
    # A same-volume rename preserves the entire object, including file identities and link bytes.
    ancestor = os.path.dirname(destination)
    while not os.path.exists(ancestor) and os.path.dirname(ancestor) != ancestor:
        ancestor = os.path.dirname(ancestor)
    if os.lstat(path).st_dev != os.stat(ancestor).st_dev:
        return False
    make_object_parents(os.path.dirname(destination))
    keys = {win.lock_key(os.path.dirname(name)) for name in (path, destination)}
    with win.locked(*keys):
        if (object_snapshot(path) != request["sourceSnapshot"] or
                object_snapshot(destination) != request["targetSnapshot"]):
            raise OperationError("TRANSFER_TARGET_CHANGED")
        removed = False
        existing = os.lstat(destination) if request["targetSnapshot"]["entries"] else None
        # Two spellings of one object (a case-only rename) must not delete the source.
        if existing is not None and (existing.st_dev, existing.st_ino) != (
                os.lstat(path).st_dev, os.lstat(path).st_ino):
            effect = "unknown"
            removed = True
            remove_object(destination, existing)
        effect = "unknown"
        try:
            os.rename(path, destination)
        except OSError:
            if not removed:
                effect = "not-applied"
            raise
        effect = "applied"
    return True
