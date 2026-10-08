"""Own JDT LS, java-debug and a suspended JVM on the selected SSH target."""
import glob
import json
import os
import pathlib
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

LIMIT = 8 * 1024 * 1024


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupted)


def send(stream, message):
    data = json.dumps(message).encode("utf8")
    stream.write(b"Content-Length: " + str(len(data)).encode("ascii") + b"\r\n\r\n" + data)
    stream.flush()


class Frames:
    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()

    def next(self, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(self.stream, selectors.EVENT_READ)
            while True:
                split = self.buffer.find(b"\r\n\r\n")
                if split >= 0:
                    headers = bytes(self.buffer[:split]).decode("ascii")
                    match = re.search(r"(?im)^Content-Length:\s*(\d+)$", headers)
                    if not match:
                        raise ValueError("Missing frame length")
                    size = int(match.group(1))
                    if size > LIMIT:
                        raise ValueError("Frame limit")
                    end = split + 4 + size
                    if len(self.buffer) >= end:
                        result = json.loads(self.buffer[split + 4:end])
                        del self.buffer[:end]
                        return result
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("Java startup deadline")
                data = os.read(self.stream.fileno(), 16384)
                if not data:
                    raise EOFError("Java protocol closed")
                self.buffer.extend(data)
                if len(self.buffer) > LIMIT + 16384:
                    raise ValueError("Frame limit")


def request(server, frames, identifier, method, parameters, deadline):
    send(server.stdin, {"jsonrpc": "2.0", "id": identifier, "method": method, "params": parameters})
    while True:
        message = frames.next(deadline)
        if message.get("method") and "id" in message:
            if message["method"] == "workspace/configuration":
                result = [None for _ in message.get("params", {}).get("items", [])]
            else:
                result = None
            send(server.stdin, {"jsonrpc": "2.0", "id": message["id"], "result": result})
        elif message.get("id") == identifier:
            if "error" in message:
                raise RuntimeError("Java language server refused request")
            return message.get("result")


def owns_socket(process, port, peer=None):
    inodes = set()
    for name in os.listdir("/proc/" + str(process.pid) + "/fd"):
        try:
            target = os.readlink("/proc/" + str(process.pid) + "/fd/" + name)
        except FileNotFoundError:
            continue
        if target.startswith("socket:["):
            inodes.add(target[8:-1])
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        with open(table, encoding="ascii") as stream:
            for line in stream:
                fields = line.split()
                if len(fields) > 9 and fields[9] in inodes and fields[1].endswith(":" + format(port, "04X")) and fields[3] == ("0A" if peer is None else "01"):
                    if peer is None or fields[2].endswith(":" + format(peer, "04X")):
                        return process.poll() is None
    return False


def relay(connection, server, frames):
    # JDT LS remains alive for java-debug. Answer server requests during the DAP session too.
    with selectors.DefaultSelector() as selector:
        selector.register(0, selectors.EVENT_READ)
        selector.register(connection, selectors.EVENT_READ)
        selector.register(server.stdout, selectors.EVENT_READ)
        while True:
            for key, _events in selector.select():
                if key.fileobj == 0:
                    data = os.read(0, 16384)
                    if not data:
                        return
                    connection.sendall(data)
                elif key.fileobj == connection:
                    data = connection.recv(16384)
                    if not data:
                        return
                    offset = 0
                    while offset < len(data):
                        offset += os.write(1, data[offset:])
                else:
                    message = frames.next(time.monotonic() + 10)
                    if message.get("method") and "id" in message:
                        result = [None for _ in message.get("params", {}).get("items", [])] if message["method"] == "workspace/configuration" else None
                        send(server.stdin, {"jsonrpc": "2.0", "id": message["id"], "result": result})


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def run():
    options = json.loads(sys.argv[1])
    main = options["mainClass"]
    if not isinstance(main, str) or not re.fullmatch(r"[\w$]+(?:\.[\w$]+)*", main):
        raise ValueError("Invalid Java main class")
    cwd = os.getcwd()
    classes = [os.path.join(cwd, candidate) for candidate in ("build/classes/java/main", "target/classes", "out/production", "bin", ".") if os.path.isfile(os.path.join(cwd, candidate, main.replace(".", "/") + ".class"))]
    if not classes:
        raise ValueError("Compile Java main class before debugging")
    home = os.environ.get("PI_JDTLS_HOME", "/opt/pi-debug-adapters/jdtls")
    plugin = os.environ.get("PI_JAVA_DEBUG_PLUGIN_PATH", "/opt/pi-debug-adapters/java-debug/com.microsoft.java.debug.plugin-0.53.2.jar")
    launchers = glob.glob(os.path.join(home, "plugins", "org.eclipse.equinox.launcher_*.jar"))
    configuration = os.path.join(home, "config_linux")
    if len(launchers) != 1 or not os.path.isfile(plugin) or not os.path.isdir(configuration):
        raise ValueError("Missing JDT LS or java-debug plugin")
    java = os.environ.get("PI_JAVA_PATH", os.path.join(os.environ["JAVA_HOME"], "bin", "java") if "JAVA_HOME" in os.environ else "java")
    server = target = None
    with tempfile.TemporaryDirectory(prefix="pi-java-debug-") as directory:
        try:
            private_configuration = os.path.join(directory, "configuration")
            shutil.copytree(configuration, private_configuration)
            environment = dict(os.environ)
            environment.pop("CLIENT_HOST", None)
            environment.pop("CLIENT_PORT", None)
            server = subprocess.Popen([java, "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Xmx512m", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", launchers[0], "-configuration", private_configuration, "-data", os.path.join(directory, "workspace")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)
            frames = Frames(server.stdout)
            deadline = time.monotonic() + 30
            request(server, frames, 1, "initialize", {"processId": os.getpid(), "rootUri": pathlib.Path(cwd).as_uri(), "capabilities": {}, "initializationOptions": {"bundles": [plugin], "settings": {"java": {"import": {"gradle": {"enabled": False}, "maven": {"enabled": False}}}}}}, deadline)
            send(server.stdin, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
            port = request(server, frames, 2, "workspace/executeCommand", {"command": "vscode.java.startDebugSession", "arguments": []}, deadline)
            if type(port) is not int or not 1 <= port <= 65535 or not owns_socket(server, port):
                raise ValueError("Java DAP port has no owned listener")
            connection = socket.create_connection(("127.0.0.1", port), timeout=5)
            with connection:
                while not owns_socket(server, port, connection.getsockname()[1]):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Java DAP accepted socket owner")
                    time.sleep(0.01)
                target = subprocess.Popen([java, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0", "-cp", ":".join(classes), main, *options["args"]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                with selectors.DefaultSelector() as selector:
                    selector.register(target.stdout, selectors.EVENT_READ)
                    output = bytearray()
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise TimeoutError("Java target startup")
                        data = os.read(target.stdout.fileno(), 4096)
                        if not data:
                            raise EOFError("Java target exited")
                        output.extend(data)
                        match = re.search(rb"Listening for transport dt_socket at address: (\d+)", output)
                        if match:
                            target_port = int(match.group(1))
                            break
                        if len(output) > 4096:
                            raise ValueError("Java target startup output limit")
                if not owns_socket(target, target_port):
                    raise ValueError("JDWP port has no owned target")
                source_root = os.path.dirname(options["sourceFile"])
                for _part in main.split(".")[1:]:
                    source_root = os.path.dirname(source_root)
                sys.stdout.write(json.dumps({"port": target_port, "sourceRoot": source_root}) + "\n")
                sys.stdout.flush()
                connection.settimeout(None)
                # Drain target output without exposing arbitrary JVM diagnostics to the controller.
                selector_thread = __import__("threading").Thread(target=lambda: shutil.copyfileobj(target.stdout, open(os.devnull, "wb")), daemon=True)
                selector_thread.start()
                relay(connection, server, frames)
        finally:
            for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, signal.SIG_IGN)
            stop(target)
            stop(server)


try:
    run()
except Exception:
    # Never expose target stderr, paths from native exceptions or environment values.
    sys.exit(1)
