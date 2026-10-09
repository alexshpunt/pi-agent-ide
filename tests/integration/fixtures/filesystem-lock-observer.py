#!/usr/bin/python3
"""Record only an owned write's real flock attempt; leave the native operation unchanged."""
import base64
import fcntl
import io
import json
import os
import pathlib
import re
import sys

bootstrap = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == "-c" else ""
match = re.fullmatch(r'exec\(__import__\("base64"\).b64decode\("([A-Za-z0-9+/=]+)"\)\)', bootstrap)
if not match or b"request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))" not in base64.b64decode(match[1]):
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])

payload = sys.stdin.buffer.read()
request = json.loads(payload)
if (request.get("path", "").endswith("/filesystem-owned.txt") and
        (request.get("operation") == "journal" or
         request.get("operation") == "write" and isinstance(request.get("expected"), str))):
    owned_parent = pathlib.Path(request["path"]).parent
    native_flock = fcntl.flock

    def observe_flock(descriptor, operation):
        if operation == fcntl.LOCK_EX and pathlib.Path("/proc/self/fd", str(descriptor)).resolve() == owned_parent:
            (owned_parent / "filesystem-owned-ready").write_text(str(os.getpid()), encoding="utf-8")
        return native_flock(descriptor, operation)

    fcntl.flock = observe_flock
    if request.get("operation") == "journal":
        import tempfile
        native_mkdtemp = tempfile.mkdtemp

        def observe_mkdtemp(*args, **kwargs):
            directory = native_mkdtemp(*args, **kwargs)
            if kwargs.get("prefix") == ".pi-ide-journal-":
                (owned_parent / "filesystem-owned-journal").write_text(directory, encoding="utf-8")
            return directory

        tempfile.mkdtemp = observe_mkdtemp

sys.stdin = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")
exec(bootstrap)
