"""Own one target adapter and relay its target-loopback DAP socket over stdio."""
import json
import os
import selectors
import socket
import subprocess
import sys
import time


def configuration():
    data = bytearray()
    while len(data) <= 65536:
        byte = os.read(0, 1)
        if not byte:
            raise ValueError("Closed configuration input")
        if byte == b"\n":
            return json.loads(data)
        data.extend(byte)
    raise ValueError("Configuration limit")


def adapter_command(config, port):
    kind = config["kind"]
    if kind == "delve":
        command = os.environ.get("PI_DELVE_PATH", "dlv")
        return [command, "dap", "--listen=127.0.0.1:" + str(port), "--log=false"]
    if kind == "ruby":
        command = os.environ.get("PI_RUBY_DEBUG_PATH", "rdbg")
        return [command, "--open", "--host", "127.0.0.1", "--port", str(port), "--no-rc", "--", config["program"], *config["args"]]
    if kind == "julia":
        command = os.environ.get("PI_JULIA_PATH", "julia")
        project = os.environ.get("PI_JULIA_DEBUG_PROJECT", "/opt/pi-debug-adapters/julia")
        script = 'using Sockets, DebugAdapter; server = listen(ip"127.0.0.1", parse(Int, ARGS[1])); conn = accept(server); run(DebugAdapter.DebugSession(conn)); close(server)'
        return [command, "--startup-file=no", "--history-file=no", "--project=" + project, "-e", script, str(port)]
    raise ValueError("Unsupported adapter")


def owns_socket(process, port, peer_port=None):
    # Never connect to a port another target process won during the bind/launch gap.
    inodes = set()
    for name in os.listdir("/proc/" + str(process.pid) + "/fd"):
        try:
            target = os.readlink("/proc/" + str(process.pid) + "/fd/" + name)
        except FileNotFoundError:
            continue
        if target.startswith("socket:["):
            inodes.add(target[8:-1])
    with open("/proc/net/tcp", encoding="ascii") as stream:
        for line in stream:
            fields = line.split()
            state = "0A" if peer_port is None else "01"
            if len(fields) > 9 and fields[1] == "0100007F:" + format(port, "04X") and fields[3] == state and fields[9] in inodes:
                if peer_port is None or fields[2] == "0100007F:" + format(peer_port, "04X"):
                    return process.poll() is None
    return False

def relay(connection):
    with selectors.DefaultSelector() as selector:
        selector.register(0, selectors.EVENT_READ)
        selector.register(connection, selectors.EVENT_READ)
        while True:
            for key, _events in selector.select():
                if key.fileobj == 0:
                    data = os.read(0, 16384)
                    if not data:
                        selector.unregister(0)
                        connection.shutdown(socket.SHUT_WR)
                    else:
                        connection.sendall(data)
                else:
                    data = connection.recv(16384)
                    if not data:
                        return
                    offset = 0
                    while offset < len(data):
                        offset += os.write(1, data[offset:])


def run():
    config = configuration()
    # No public listener or controller forwarding. A bind race must fail, never change hosts.
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(adapter_command(config, port), stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 30
        while True:
            if process.poll() is not None:
                raise RuntimeError("Adapter exited before accepting DAP")
            if time.monotonic() >= deadline:
                raise TimeoutError("Adapter did not accept DAP")
            if not owns_socket(process, port):
                time.sleep(0.025)
                continue
            try:
                connection = socket.create_connection(("127.0.0.1", port), timeout=0.2)
                break
            except OSError:
                time.sleep(0.025)
        with connection:
            # Check the accepted socket's inode too, before sending even an initialize frame.
            while not owns_socket(process, port, connection.getsockname()[1]):
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("DAP connection owner changed")
                time.sleep(0.025)
            connection.settimeout(None)
            relay(connection)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


try:
    run()
except Exception:
    # No native stderr, environment or adapter authentication data is sent to the controller.
    sys.exit(1)
