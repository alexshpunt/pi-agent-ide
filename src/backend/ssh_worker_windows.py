"""Windows file operations. Paths arrive as `/C:/...` and leave in the same form.

Read-only operations and the guarded Git index write are available; other mutations report
CAPABILITY_UNAVAILABLE until Windows locking and replacement semantics are implemented.
"""
import base64
import hashlib
import json
import os
import stat
import subprocess
import tempfile

from ssh_paths import InvalidPath, windows_native, windows_wire
from ssh_worker_common import MAX_BYTES, OperationError, encoded

effect = "not-applied"


def native(path):
    try:
        return windows_native(path)
    except InvalidPath:
        raise OperationError("INVALID_PATH")


def wire(path):
    try:
        return windows_wire(path)
    except InvalidPath:
        raise OperationError("INVALID_PATH")


def fingerprint(path, data, info):
    identity = (os.path.realpath(path), info.st_dev, info.st_ino, info.st_mode,
                info.st_size, info.st_mtime_ns, getattr(info, "st_file_attributes", 0))
    return hashlib.sha256(json.dumps(identity).encode("utf8") + b"\0" + data).hexdigest()


def kind_of(info):
    return ("symlink" if stat.S_ISLNK(info.st_mode) else
            "directory" if stat.S_ISDIR(info.st_mode) else
            "file" if stat.S_ISREG(info.st_mode) else "other")


def read_snapshot(path):
    fd = os.open(path, os.O_RDONLY | os.O_BINARY)
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


def perform(request):
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
    if operation == "realpath":
        return wire(os.path.realpath(path, strict=True))
    if operation == "lstat":
        info = os.lstat(path)
        return {"kind": kind_of(info), "size": info.st_size, "mode": stat.S_IMODE(info.st_mode),
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
                data = source.read(min(count, info.st_size - offset))
            if revision != fingerprint(path, b"", os.fstat(fd)):
                raise OperationError("CONFLICT")
            return {"bytes": encoded(data), "offset": offset, "totalBytes": info.st_size,
                    "revision": revision}
        finally:
            os.close(fd)
    if operation == "list":
        with os.scandir(path) as entries:
            return [{"name": item.name,
                     "kind": "symlink" if item.is_symlink() else "directory" if item.is_dir()
                     else "file" if item.is_file() else "other"}
                    for item in sorted(entries, key=lambda item: item.name)]
    raise OperationError("CAPABILITY_UNAVAILABLE")
