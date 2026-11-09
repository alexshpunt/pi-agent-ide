"""Windows file operations. Paths arrive as `/C:/...` and leave in the same form.

Read-only operations are available; mutations report CAPABILITY_UNAVAILABLE until Windows
locking and replacement semantics are implemented.
"""
import hashlib
import json
import os
import stat
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


def perform(request):
    operation = request["operation"]
    path = native(request["path"]) if isinstance(request.get("path"), str) else None
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
