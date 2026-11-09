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
    try:
        packet = json.loads(line)
    except ValueError:
        packet = None  # The bootstrap's handshake precedes the frames.
    if not isinstance(packet, dict) or packet.get("kind") != "exit":
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
sys.exit(process.wait())
