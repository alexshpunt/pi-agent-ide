#!/usr/bin/python3
"""Gate only this fixture's chosen write before execution or after its real commit."""
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import time

# Only the short-operation JSON bootstrap is gated. Framed services retain their live stdin.
bootstrap = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == "-c" else ""
match = re.fullmatch(r'exec\(__import__\("base64"\).b64decode\("([A-Za-z0-9+/=]+)"\)\)', bootstrap)
if not match or b"request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))" not in base64.b64decode(match[1]):
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])
payload = sys.stdin.buffer.read()
request = json.loads(payload)
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
