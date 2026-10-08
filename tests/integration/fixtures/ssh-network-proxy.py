"""Forward SSH bytes through one fixture-owned Unix socket without inspecting or logging them."""
import os
import selectors
import socket
import sys

connection = socket.socket(socket.AF_UNIX)
connection.connect(sys.argv[1])
try:
    with selectors.DefaultSelector() as selection:
        selection.register(0, selectors.EVENT_READ)
        selection.register(connection, selectors.EVENT_READ)
        while True:
            for key, _ in selection.select():
                if key.fileobj == 0:
                    data = os.read(0, 65536)
                    if data:
                        connection.sendall(data)
                    else:
                        selection.unregister(0)
                        connection.shutdown(socket.SHUT_WR)
                else:
                    data = connection.recv(65536)
                    if not data:
                        sys.exit(0)
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
finally:
    connection.close()
