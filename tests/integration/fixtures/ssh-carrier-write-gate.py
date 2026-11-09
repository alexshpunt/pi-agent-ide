#!/usr/bin/python3
"""Gate only this fixture's chosen write before execution or after its real commit."""
import base64
import json
import os
import pathlib
import subprocess
import sys
import time

# Framed services need their live stdin. Only the short-operation JSON worker is selected:
# the channel starts it as `python3 -u -c LOADER` and sends the length-prefixed program first.
if sys.argv[1:3] != ["-u", "-c"] or len(sys.argv) != 4:
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])
data = sys.stdin.buffer.read()
size = int(data[:10])
if b"ssh_worker_common.run(ssh_worker_platform)" not in data[10:10 + size]:
    result = subprocess.run(["/usr/bin/python3", *sys.argv[1:]], input=data, capture_output=True)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
payload = data
request = json.loads(data[10 + size:])
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
