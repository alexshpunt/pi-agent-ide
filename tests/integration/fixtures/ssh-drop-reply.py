#!/usr/bin/python3
"""Run the real short-operation worker, then discard one owned write acknowledgement."""
import base64
import json
import os
import re
import subprocess
import sys

# Framed services need their live stdin. Only the selected JSON worker is forwarded below.
bootstrap = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == "-c" else ""
match = re.fullmatch(r'exec\(__import__\("base64"\).b64decode\("([A-Za-z0-9+/=]+)"\)\)', bootstrap)
if not match or b"request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))" not in base64.b64decode(match[1]):
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])
payload = sys.stdin.buffer.read()
request = json.loads(payload)
result = subprocess.run(["/usr/bin/python3", *sys.argv[1:]], input=payload, capture_output=True)
if (request.get("operation") == "write" and request.get("path", "").endswith("/drop-owned.txt")
        and request.get("bytes") == base64.b64encode(b"after\n").decode("ascii")
        and result.returncode == 0):
    sys.exit(127)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
