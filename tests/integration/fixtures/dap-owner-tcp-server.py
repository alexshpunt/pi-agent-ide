#!/usr/bin/env python3
"""Target-loopback DAP peer for transport checks, not a language debugger."""
import io
import os
import runpy
import socket
import sys
import time

if os.environ.get("PI_IDE_DAP_PEER_PIDFILE"):
    with open(os.environ["PI_IDE_DAP_PEER_PIDFILE"], "w", encoding="ascii") as stream:
        stream.write(str(os.getpid()))
time.sleep(float(os.environ.get("PI_IDE_DAP_PEER_DELAY", "0")))
if "--port" in sys.argv:
    port = int(sys.argv[sys.argv.index("--port") + 1])
elif any(value.startswith("--listen=127.0.0.1:") for value in sys.argv):
    port = int(next(value for value in sys.argv if value.startswith("--listen=127.0.0.1:")).rsplit(":", 1)[1])
else:
    port = int(sys.argv[-1])
with socket.socket() as server:
    server.bind(("127.0.0.1", port))
    server.listen(1)
    connection, _address = server.accept()
    with connection:
        sys.stdin = io.TextIOWrapper(connection.makefile("rb"), encoding="utf-8")
        sys.stdout = io.TextIOWrapper(connection.makefile("wb"), encoding="utf-8")
        runpy.run_path(os.path.join(os.path.dirname(__file__), "owned-stdio-peer"), run_name="__main__")
