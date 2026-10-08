#!/usr/bin/env python3
"""An owned fake R parent whose different child sends synthetic DAP responses."""
import json
import os
import signal
import socket
import subprocess
import sys


def stop(_number, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if len(sys.argv) > 1 and sys.argv[1] == "--peer":
    port, sequence, marker = sys.argv[2:]
    with socket.create_connection(("127.0.0.1", int(port))) as connection:
        response = json.dumps({"seq": 1, "type": "response", "request_seq": int(sequence),
                               "command": "initialize", "success": True, "body": {"untrusted": True}}).encode("ascii")
        connection.sendall(b"Content-Length: " + str(len(response)).encode("ascii") + b"\r\n\r\n" + response)
        if connection.recv(16384):
            with open(marker, "w", encoding="utf-8") as stream:
                stream.write("received controller protocol bytes")
else:
    line = sys.stdin.readline()
    literal = line.split("vscDebugger:::.vsc.handleDap(", 1)[1].rsplit(")", 1)[0]
    packet = json.loads(literal)
    request = json.loads(packet.split("\r\n\r\n", 1)[1])
    if os.environ.get("PI_IDE_R_EXIT_FAILURE") == "1":
        with socket.create_connection(("127.0.0.1", request["arguments"]["dapPort"])) as connection:
            payload = json.dumps({"seq": 1, "type": "response", "request_seq": request["seq"],
                                  "command": "initialize", "success": True, "body": {}}).encode("ascii")
            connection.sendall(b"Content-Length: " + str(len(payload)).encode("ascii") + b"\r\n\r\n" + payload)
            connection.recv(16384)
        sys.exit(7)
    if os.environ.get("PI_IDE_R_FLOW_SPAM") == "1":
        with socket.create_connection(("127.0.0.1", request["arguments"]["dapPort"])) as connection:
            events = [{"seq": 1, "type": "response", "request_seq": request["seq"],
                       "command": "initialize", "success": True, "body": {}}]
            events.extend({"seq": i + 2, "type": "event", "event": "custom", "body": {
                "reason": "writeToStdin", "when": "browserPrompt", "text": "fixture-only-input"}}
                for i in range(129))
            for event in events:
                payload = json.dumps(event).encode("ascii")
                connection.sendall(b"Content-Length: " + str(len(payload)).encode("ascii") + b"\r\n\r\n" + payload)
            while connection.recv(16384):
                pass
        sys.exit(0)
    process = subprocess.Popen([sys.executable, __file__, "--peer", str(request["arguments"]["dapPort"]),
                                str(request["seq"]), os.environ["PI_IDE_R_MARKER"]])
    try:
        process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
