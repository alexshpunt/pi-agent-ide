#!/usr/bin/python3
"""Run the real short-operation worker, then discard one owned write acknowledgement."""
import base64
import json
import os
import subprocess
import sys

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
result = subprocess.run(["/usr/bin/python3", *sys.argv[1:]], input=payload, capture_output=True)
if (request.get("operation") == "write" and request.get("path", "").endswith("/drop-owned.txt")
        and request.get("bytes") == base64.b64encode(b"after\n").decode("ascii")
        and result.returncode == 0):
    sys.exit(127)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
