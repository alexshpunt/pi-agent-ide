"""Relay a Unix DAP socket only after checking its exact native peer identity."""
import os
import selectors
import socket
import struct
import sys
import time


def identity(pid):
    with open("/proc/" + str(pid) + "/stat", encoding="utf-8") as stream:
        fields = stream.read().rsplit(") ", 1)[1].split()
    if fields[0] == "Z":
        raise RuntimeError("Peer exited")
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        return stream.read().strip() + ":" + fields[19]


def run():
    path, pid_text, expected = sys.argv[1:]
    pid = int(pid_text)
    deadline = time.monotonic() + 30
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        while True:
            if identity(pid) != expected:
                raise RuntimeError("Peer identity changed")
            try:
                connection.connect(path)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Peer did not accept DAP")
                time.sleep(0.025)
        credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        if struct.unpack("3i", credentials)[0] != pid or identity(pid) != expected:
            raise RuntimeError("Socket belongs to another process")
        # No protocol bytes have been sent before both native checks succeed.
        with selectors.DefaultSelector() as selector:
            selector.register(0, selectors.EVENT_READ)
            selector.register(connection, selectors.EVENT_READ)
            while True:
                for key, _events in selector.select():
                    if key.fileobj == 0:
                        data = os.read(0, 16384)
                        if data:
                            connection.sendall(data)
                        else:
                            selector.unregister(0)
                            connection.shutdown(socket.SHUT_WR)
                    else:
                        data = connection.recv(16384)
                        if not data:
                            return
                        offset = 0
                        while offset < len(data):
                            offset += os.write(1, data[offset:])


try:
    run()
except Exception:
    # Native paths, adapter logs and authentication values are not diagnostic output.
    sys.exit(1)
