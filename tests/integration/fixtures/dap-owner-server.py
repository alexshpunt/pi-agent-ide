#!/usr/bin/env python3
"""Small real-stdio DAP peer for owned transport checks, not a language-debugger fixture."""
import json
import os
import sys

sys.stderr.write("adapter startup output\n" * 8192)
sys.stderr.flush()
while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line == b"\r\n":
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1].strip())
    if length is None:
        sys.exit(1)
    request = json.loads(sys.stdin.buffer.read(length))
    if os.environ.get("PI_IDE_DAP_PEER_RECEIVED"):
        with open(os.environ["PI_IDE_DAP_PEER_RECEIVED"], "w", encoding="ascii") as stream:
            stream.write(request["command"])
    if request["command"] == "pending":
        continue
    response = {"seq": request["seq"], "type": "response", "request_seq": request["seq"], "command": request["command"], "success": True, "body": {"pid": os.getpid()} if request["command"] == "peerPid" else {"args": sys.argv[1:]} if request["command"] == "peerArguments" else request.get("arguments")}
    payload = json.dumps(response, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(payload)).encode("ascii") + b"\r\n\r\n" + payload)
    sys.stdout.buffer.flush()
