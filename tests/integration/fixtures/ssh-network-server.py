"""Own an isolated loopback HTTP endpoint and SSH server behind a private Unix socket."""
import http.server
import json
import os
import pathlib
import selectors
import signal
import socket
import subprocess
import sys
import threading

config, socket_path, workspace = map(pathlib.Path, sys.argv[1:])
stopping = threading.Event()
connections = set()
connection_lock = threading.Lock()


def stop(_signal, _frame):
    stopping.set()


def control():
    # A PID-namespace wrapper waits for init; use its exact inherited pipe, not a PID signal.
    for command in sys.stdin:
        if command.rstrip("\n") == "stop":
            stopping.set()
            return
    stopping.set()


def forward(client, port):
    upstream = socket.socket()
    with connection_lock:
        connections.update((client, upstream))
    try:
        upstream.connect(("127.0.0.1", port))
        with selectors.DefaultSelector() as selection:
            selection.register(client, selectors.EVENT_READ, upstream)
            selection.register(upstream, selectors.EVENT_READ, client)
            while not stopping.is_set():
                for key, _ in selection.select(0.2):
                    data = key.fileobj.recv(65536)
                    if not data:
                        return
                    key.data.sendall(data)
    except OSError:
        pass
    finally:
        with connection_lock:
            connections.discard(client)
            connections.discard(upstream)
        client.close()
        upstream.close()


class Page(http.server.BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        route = self.path.split("?", 1)[0]
        body = (
            '<html><body style="margin:0;background:#ff0000"></body></html>'
            if route == "/red"
            else '<html><body><script>document.body.innerHTML="<article><h1>Isolated café browser</h1><p>Native value 43</p></article>"</script></body></html>'
            if route == "/browser"
            else '<html><body><article><h1>Isolated café HTTP</h1><p>Native value 42</p><a href="./detail">Detail</a></article></body></html>'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
subprocess.run(["/usr/sbin/ip", "link", "set", "lo", "up"], check=True)
port = next(int(line.split()[1]) for line in config.read_text().splitlines() if line.startswith("Port "))
http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
http.daemon_threads = True
http_thread = threading.Thread(target=http.serve_forever)
listener = socket.socket(socket.AF_UNIX)
server = None
threads = []
try:
    listener.bind(str(socket_path))
    listener.listen()
    listener.settimeout(0.2)
    server = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)])
    http_thread.start()
    if os.getpid() == 1:
        threading.Thread(target=control, daemon=True).start()
    (workspace / "network-proof.json").write_text(json.dumps({
        "url": f"http://127.0.0.1:{http.server_port}",
        "namespace": os.readlink("/proc/self/ns/net"),
        "pidNamespace": os.readlink("/proc/self/ns/pid"),
        "mountNamespace": os.readlink("/proc/self/ns/mnt"),
        "supervisorPid": os.getpid(),
        "sshdPid": server.pid,
    }), encoding="utf-8")
    while not stopping.is_set():
        if server.poll() is not None:
            raise RuntimeError("Private namespace sshd exited")
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        thread = threading.Thread(target=forward, args=(client, port))
        threads.append(thread)
        thread.start()
finally:
    stopping.set()
    listener.close()
    with connection_lock:
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    for thread in threads:
        thread.join()
    if server is not None and server.poll() is None:
        server.terminate()
        server.wait(timeout=5)
    if http_thread.is_alive():
        http.shutdown()
        http_thread.join()
    http.server_close()
    socket_path.unlink(missing_ok=True)
