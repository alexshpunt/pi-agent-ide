#!/usr/bin/python3
"""Run the real owned worker and drop only its authoritative process exit frame."""
import json
import subprocess
import sys

process = subprocess.Popen(
    ["/usr/bin/python3", *sys.argv[1:]],
    stdin=sys.stdin.buffer,
    stdout=subprocess.PIPE,
    stderr=sys.stderr,
)
for line in process.stdout:
    packet = json.loads(line)
    if packet.get("kind") != "exit":
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
sys.exit(process.wait())
