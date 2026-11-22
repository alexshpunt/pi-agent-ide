"""Receive one bounded-memory byte stream on Windows, then publish only after its checksum arrives."""
import errno
import hashlib
import json
import os
import sys
import tempfile

import ssh_windows_files as win

effect = "not-applied"
temporary = None
reply = None
try:
    request = json.loads(sys.argv[1])
    destination = win.native(request["destination"])
    length = request["size"]
    if not isinstance(length, int) or length < 0:
        raise win.Failure("INVALID_ARGUMENTS", "not-applied")

    def revision(path):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return None
        if win.kind_of(info) != "file":
            raise win.Failure("INVALID_FILE_TYPE", "not-applied")
        return win.fingerprint(path, b"", info)

    parent = os.path.dirname(destination)
    if revision(destination) != request["expected"]:
        raise win.Failure("CONFLICT", "not-applied")
    os.makedirs(parent, exist_ok=True)
    with win.locked(win.lock_key(parent)):
        if revision(destination) != request["expected"]:
            raise win.Failure("CONFLICT", "not-applied")
        fd, temporary = tempfile.mkstemp(prefix=".pi-ide-transfer-", dir=parent)
        digest = hashlib.sha256()
        with os.fdopen(fd, "wb") as target:
            remaining = length
            while remaining:
                chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise win.Failure("INCOMPLETE_TRANSFER", "not-applied")
                target.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            # The sender checks its source again before sending this commit request.
            trailer = sys.stdin.buffer.readline(1024)
            if not trailer.endswith(b"\n"):
                raise win.Failure("INCOMPLETE_TRANSFER", "not-applied")
            if json.loads(trailer).get("sha256") != digest.hexdigest():
                raise win.Failure("CHECKSUM_MISMATCH", "not-applied")
            if sys.stdin.buffer.read(1):
                raise win.Failure("INVALID_ARGUMENTS", "not-applied")
            target.flush()
            os.fsync(target.fileno())
        # Windows has no POSIX mode; a source without owner write access stays read-only.
        if not request["mode"] & 0o200:
            win.set_attributes(temporary, win.FILE_ATTRIBUTE_READONLY)
        if revision(destination) != request["expected"]:
            raise win.Failure("CONFLICT", "not-applied")
        effect = "unknown"
        try:
            win.publish(temporary, destination)
        except win.Failure as failure:
            effect = failure.effect or "unknown"
            raise
        temporary = None
        effect = "applied"
    reply = {"ok": True, "sha256": digest.hexdigest(), "effect": effect}
except win.Failure as failure:
    reply = {"ok": False, "code": failure.code, "effect": failure.effect or effect}
except OSError as error:
    reply = {"ok": False,
             "code": win.error_code(error) or errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED"),
             "effect": effect}
except Exception:
    reply = {"ok": False, "code": "REMOTE_OPERATION_FAILED", "effect": effect}
finally:
    if temporary is not None:
        win.discard(temporary)
sys.stdout.write(json.dumps(reply) + "\n")
sys.stdout.flush()
