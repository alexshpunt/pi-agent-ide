"""Relay one exact target R process and its browser-prompt DAP flow over stdio."""
import json
import os
import re
import selectors
import signal
import socket
import subprocess
import sys
import time

LIMIT = 4 * 1024 * 1024
LISTEN = "vscDebugger::.vsc.listenForDAP(timeout=-1)"


def frame(message):
    body = json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def messages(buffer):
    while True:
        end = buffer.find(b"\r\n\r\n")
        if end < 0:
            if len(buffer) > 4096:
                raise ValueError("DAP header limit")
            return
        match = re.fullmatch(rb"Content-Length: (\d+)", buffer[:end])
        if not match:
            raise ValueError("Invalid DAP header")
        length = int(match[1])
        if length > LIMIT:
            raise ValueError("DAP message limit")
        total = end + 4 + length
        if len(buffer) < total:
            return
        packet = bytes(buffer[:total])
        message = json.loads(buffer[end + 4:total])
        del buffer[:total]
        yield message, packet


def initialize():
    buffer = bytearray()
    # Read only the first frame, leaving subsequent requests on the pipe.
    while len(buffer) <= LIMIT + 4096:
        byte = os.read(0, 1)
        if not byte:
            raise ValueError("Closed initialization input")
        buffer.extend(byte)
        for message, _packet in messages(buffer):
            if message.get("type") != "request" or message.get("command") != "initialize":
                raise ValueError("Expected initialize request")
            return message
    raise ValueError("Initialization limit")


def owns_peer(process, local_port, listener_port):
    inodes = set()
    for name in os.listdir("/proc/" + str(process.pid) + "/fd"):
        try:
            link = os.readlink("/proc/" + str(process.pid) + "/fd/" + name)
        except FileNotFoundError:
            continue
        if link.startswith("socket:["):
            inodes.add(link[8:-1])
    with open("/proc/net/tcp", encoding="ascii") as stream:
        for line in stream:
            fields = line.split()
            if len(fields) > 9 and fields[3] == "01" and fields[9] in inodes:
                if fields[1] == "0100007F:" + format(local_port, "04X") and fields[2] == "0100007F:" + format(listener_port, "04X"):
                    return process.poll() is None
    return False


def write_all(fd, data):
    while data:
        count = os.write(fd, data)
        data = data[count:]


def run():
    request = initialize()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(0.05)
        port = listener.getsockname()[1]
        arguments = request.setdefault("arguments", {})
        arguments.update({
            "useDapSocket": True, "dapHost": "127.0.0.1", "dapPort": port,
            "supportsWriteToStdinEvent": True, "supportsStdoutReading": True,
            "rStrings": {"packageName": "vscDebugger", "prompt": "__PI_R_PROMPT__",
                         "continue": "__PI_R_CONTINUE__", "attachName": "tools:vscDebugger"},
        })
        process = subprocess.Popen([os.environ.get("PI_R_PATH", "R"), "--vanilla", "--quiet"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            bootstrap = "library(vscDebugger); vscDebugger:::.vsc.handleDap(" + json.dumps(frame(request).decode("ascii")) + ")\n"
            write_all(process.stdin.fileno(), bootstrap.encode("utf-8"))
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("R did not connect")
                try:
                    connection, peer = listener.accept()
                except socket.timeout:
                    continue
                # No DAP bytes from any other native process enter this relay.
                if not owns_peer(process, peer[1], port):
                    connection.close()
                    raise RuntimeError("R connection owner changed")
                break
            with connection, selectors.DefaultSelector() as selector:
                selector.register(0, selectors.EVENT_READ)
                selector.register(process.stdout, selectors.EVENT_READ)
                selector.register(connection, selectors.EVENT_READ)
                outgoing = bytearray()
                incoming = bytearray()
                output = ""
                queued = []
                at_browser = False
                fallback_at = None
                started = False
                completed = False
                def send_input(text):
                    write_all(process.stdin.fileno(), (text + "\n").encode("utf-8"))
                while True:
                    for key, _events in selector.select(0.05):
                        if key.fileobj == 0:
                            data = os.read(0, 16384)
                            if not data:
                                return
                            incoming.extend(data)
                            for message, packet in messages(incoming):
                                if message.get("type") == "request" and message.get("command") == "configurationDone":
                                    started = True
                                connection.sendall(packet)
                        elif key.fileobj is connection:
                            data = connection.recv(16384)
                            if not data:
                                if outgoing or not completed:
                                    raise RuntimeError("R protocol closed before completion")
                                return
                            outgoing.extend(data)
                            for message, packet in messages(outgoing):
                                if (message.get("type") == "event" and message.get("event") in ("terminated", "exited")) or (message.get("type") == "response" and message.get("command") in ("disconnect", "terminate") and message.get("success") is True):
                                    completed = True
                                body = message.get("body") or {}
                                if message.get("event") == "custom" and body.get("reason") == "writeToStdin" and body.get("text"):
                                    if body.get("when") == "browserPrompt" and at_browser:
                                        at_browser = False
                                        fallback_at = None
                                        send_input(body["text"])
                                    else:
                                        if len(queued) >= 128:
                                            raise ValueError("Pending prompt input limit")
                                        queued.append(body["text"])
                                write_all(1, packet)
                        else:
                            data = os.read(process.stdout.fileno(), 16384)
                            if not data:
                                # Console EOF is not protocol completion. Drain queued socket frames.
                                selector.unregister(process.stdout)
                                continue
                            # Native console text is flow control only, not DAP or diagnostics.
                            output += data.decode("utf-8", errors="replace")
                            while True:
                                prompt = re.search(r"Browse\[\d+\]> |(?:^|\r?\n)__PI_R_PROMPT__(?:\r?\n|$)", output)
                                if not prompt:
                                    output = output[-128:]
                                    break
                                text = prompt[0]
                                output = output[prompt.end():]
                                if text.startswith("Browse["):
                                    if queued:
                                        send_input(queued.pop(0))
                                    else:
                                        at_browser = True
                                        fallback_at = time.monotonic() + 0.1
                                else:
                                    send_input(LISTEN)
                                    if started:
                                        # Reserve a negative sequence for the broker's prompt notification.
                                        connection.sendall(frame({"seq": -1, "type": "request", "command": "custom", "arguments": {"reason": "showingPrompt", "which": "topLevel"}}))
                    if at_browser and fallback_at is not None and time.monotonic() >= fallback_at:
                        at_browser = False
                        fallback_at = None
                        send_input(LISTEN)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def stop(_number, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    run()
except Exception:
    # Do not expose native stderr, adapter authentication or environment values.
    sys.exit(1)
