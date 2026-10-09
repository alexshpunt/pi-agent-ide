"""Receive one bounded-memory byte stream, then publish only after its checksum arrives."""
import errno
import fcntl
import hashlib
import json
import os
import signal
import stat
import sys
import tempfile


class TransferError(Exception):
    def __init__(self, code):
        self.code = code


def interrupted(_signal, _frame):
    raise TransferError("CANCELLED")


for handled in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(handled, interrupted)


def revision(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise TransferError("INVALID_FILE_TYPE")
    identity = (os.path.realpath(path), info.st_dev, info.st_ino, info.st_mode,
                info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return hashlib.sha256(json.dumps(identity).encode("utf8") + b"\0").hexdigest()


effect = "not-applied"
temporary = None
parent_fd = None
try:
    request = json.loads(sys.argv[1])
    destination = request["destination"]
    length = request["size"]
    if not isinstance(length, int) or length < 0:
        raise TransferError("INVALID_ARGUMENTS")
    parent = os.path.dirname(destination)
    if revision(destination) != request["expected"]:
        raise TransferError("CONFLICT")
    os.makedirs(parent, exist_ok=True)
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    fcntl.flock(parent_fd, fcntl.LOCK_EX)
    if revision(destination) != request["expected"]:
        raise TransferError("CONFLICT")
    fd, temporary = tempfile.mkstemp(prefix=".pi-ide-transfer-", dir=parent)
    digest = hashlib.sha256()
    with os.fdopen(fd, "wb") as target:
        remaining = length
        while remaining:
            chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
            if not chunk:
                raise TransferError("INCOMPLETE_TRANSFER")
            target.write(chunk)
            digest.update(chunk)
            remaining -= len(chunk)
        # The sender checks its source again before sending this commit request.
        trailer = sys.stdin.buffer.readline(1024)
        if not trailer.endswith(b"\n"):
            raise TransferError("INCOMPLETE_TRANSFER")
        commit = json.loads(trailer)
        if commit.get("sha256") != digest.hexdigest():
            raise TransferError("CHECKSUM_MISMATCH")
        if sys.stdin.buffer.read(1):
            raise TransferError("INVALID_ARGUMENTS")
        os.fchmod(target.fileno(), request["mode"] & 0o7777)
        target.flush()
        os.fsync(target.fileno())
    if revision(destination) != request["expected"]:
        raise TransferError("CONFLICT")
    effect = "unknown"
    os.replace(temporary, destination)
    temporary = None
    effect = "applied"
    reply = {"ok": True, "sha256": digest.hexdigest(), "effect": effect}
except TransferError as error:
    reply = {"ok": False, "code": error.code, "effect": effect}
except OSError as error:
    reply = {"ok": False, "code": errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED"), "effect": effect}
except Exception:
    reply = {"ok": False, "code": "REMOTE_OPERATION_FAILED", "effect": effect}
finally:
    if temporary is not None:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    if parent_fd is not None:
        os.close(parent_fd)
print(json.dumps(reply), flush=True)
