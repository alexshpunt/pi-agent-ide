#!/usr/bin/python3
"""Gate only this fixture's chosen write before execution or after its real commit."""
import base64
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

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
request_bytes = sys.stdin.buffer.read()
payload = header + program + request_bytes
request = json.loads(request_bytes)
owned = (request.get("operation") == "write"
         and request.get("path", "").endswith("/carrier-owned.txt")
         and request.get("bytes") == base64.b64encode(b"after caf\xc3\xa9\n").decode("ascii"))
if not owned:
    result = subprocess.run(["/usr/bin/python3", *sys.argv[1:]], input=payload, capture_output=True)
else:
    folder = pathlib.Path(request["path"]).parent
    phase = os.environ["CARRIER_WRITE_PHASE"]
    result = None
    if phase == "after":
        result = subprocess.run(["/usr/bin/python3", *sys.argv[1:]], input=payload, capture_output=True)
        if result.returncode != 0:
            sys.stdout.buffer.write(result.stdout)
            sys.stderr.buffer.write(result.stderr)
            sys.exit(result.returncode)
    (folder / "carrier-write-ready").write_text(json.dumps({"pid": os.getpid(), "phase": phase}), encoding="utf-8")
    deadline = time.monotonic() + 30
    while not (folder / "carrier-write-release").exists() and time.monotonic() < deadline:
        time.sleep(.02)
    if result is None:
        # The before-commit gate never executes a mutation after its owner cuts the carrier.
        sys.exit(1)

sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
