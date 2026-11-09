#!/usr/bin/python3
"""Record only an owned write's real flock attempt; leave the native operation unchanged."""
import fcntl
import io
import json
import os
import pathlib
import subprocess
import sys
import threading

def read_exact(count):
    data = bytearray()
    while len(data) < count:
        chunk = os.read(0, count - len(data))
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


def forward(prefix):
    """Run the real interpreter: replay the consumed program bytes, then stream live stdin."""
    child = subprocess.Popen(["/usr/bin/python3", *sys.argv[1:]], stdin=subprocess.PIPE)

    def pump():
        try:
            child.stdin.write(prefix)
            child.stdin.flush()
            while chunk := os.read(0, 65536):
                child.stdin.write(chunk)
                child.stdin.flush()
            child.stdin.close()
        except (BrokenPipeError, ValueError):
            pass

    # The worker's own exit ends this wrapper, even while its caller keeps stdin open.
    threading.Thread(target=pump, daemon=True).start()
    os._exit(child.wait())


# The channel starts IDE workers as `python3 -u -c LOADER` and sends the length-prefixed program
# on stdin first. Only the short-operation JSON worker is selected; services keep live stdin.
if sys.argv[1:3] != ["-u", "-c"] or len(sys.argv) != 4:
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])
header = read_exact(10)
program = read_exact(int(header))
if b"ssh_worker_common.run(ssh_worker_platform)" not in program:
    forward(header + program)
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
exec(compile(program, "<pi-agent-ide>", "exec"))
