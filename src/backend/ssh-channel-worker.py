"""Transient framed pipe/PTY channel for remote services. Nothing is installed remotely."""
import base64
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time

FRAME_LIMIT = 65536
# Match the bounded startup request; interactive control frames keep their smaller limit.
REQUEST_LIMIT = 48 * 1024 * 1024
CHUNK_SIZE = 16384
process = None
master = None


class ChannelError(Exception):
    def __init__(self, code):
        self.code = code


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def interrupted(_signum, _frame):
    raise ChannelError("CANCELLED")


for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, interrupted)


def initial_request():
    data = bytearray()
    while len(data) <= REQUEST_LIMIT:
        byte = os.read(0, 1)
        if not byte:
            raise ChannelError("CANCELLED")
        if byte == b"\n":
            return json.loads(data)
        data.extend(byte)
    raise ChannelError("FRAME_LIMIT")


def resize(cols, rows):
    if master is None:
        raise ChannelError("PTY_REQUIRED")
    if not isinstance(cols, int) or not isinstance(rows, int) or not (1 <= cols <= 1000 and 1 <= rows <= 1000):
        raise ChannelError("INVALID_REQUEST")
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass


def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def kill_group(sig):
    # A reaped leader no longer grants authority over its numeric process-group ID.
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass


def enable_subreaper():
    # The kernel keeps orphaned descendants with this channel, even after setsid().
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        prctl = libc.prctl
    except (ImportError, OSError, AttributeError):
        raise ChannelError("CAPABILITY_UNAVAILABLE")
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise ChannelError(errno.errorcode.get(ctypes.get_errno(), "CAPABILITY_UNAVAILABLE"))
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def stop_adopted_children():
    # Read only our direct kernel children, not a system-wide ancestry snapshot.
    directory = "/proc/self/task/" + str(os.getpid()) + "/children"
    with open(directory, encoding="utf-8") as stream:
        children = [int(value) for value in stream.read().split()]
    pending = False
    for pid in children:
        if process is not None and pid == process.pid:
            continue
        # A running child cannot reuse its PID before this single-threaded parent reaps it.
        reaped, _status = os.waitpid(pid, os.WNOHANG)
        if reaped == 0:
            os.kill(pid, signal.SIGKILL)
            pending = True
    return pending


def finish_children():
    deadline = time.monotonic() + 2
    kill_group(signal.SIGKILL)
    while process.poll() is None or stop_adopted_children():
        if time.monotonic() >= deadline:
            raise ChannelError("PROCESS_CLEANUP_FAILED")
        time.sleep(0.02)

def child_identity():
    # A reaped child may already have disappeared. Missing metadata never grants PID ownership.
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as stream:
            boot_id = stream.read(128).strip()
        with open("/proc/" + str(process.pid) + "/stat", encoding="utf-8") as stream:
            raw = stream.read(65536)
        ticks = raw[raw.rfind(")") + 2:].split()[19]
        return boot_id + ":" + ticks if process.poll() is None else None
    except (OSError, IndexError):
        return None

def run():
    global process, master
    request = initial_request()
    enable_subreaper()
    dimensions = request.get("pty")
    if dimensions is None:
        process = subprocess.Popen(
            [request["command"], *request["args"]], cwd=request["cwd"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        input_fd = process.stdin.fileno()
        outputs = {name: getattr(process, name).fileno() for name in ("stdout", "stderr")}
    else:
        master, slave = pty.openpty()
        try:
            resize(dimensions["cols"], dimensions["rows"])
            process = subprocess.Popen(
                [request["command"], *request["args"]], cwd=request["cwd"],
                stdin=slave, stdout=slave, stderr=slave,
                env={**os.environ, "TERM": "xterm-256color"},
                preexec_fn=controlling_terminal,
            )
        finally:
            os.close(slave)
        input_fd = master
        outputs = {"stdout": master}
    identity = child_identity()
    emit({"kind": "ready", "pid": process.pid, **({"identity": identity} if identity is not None else {})})
    incoming = bytearray()
    pending_input = None
    stopping = None
    descendant_deadline = None
    input_open = True
    with selectors.DefaultSelector() as selected:
        os.set_blocking(0, False)
        selected.register(0, selectors.EVENT_READ, "control")
        for name, fd in outputs.items():
            os.set_blocking(fd, False)
            selected.register(fd, selectors.EVENT_READ, "pty" if fd == master else name)
        os.set_blocking(input_fd, False)

        def input_poll(active):
            if master is not None:
                if "stdout" in outputs:
                    selected.modify(master, selectors.EVENT_READ | (selectors.EVENT_WRITE if active else 0), "pty")
            elif active:
                selected.register(input_fd, selectors.EVENT_WRITE, "input")
            else:
                selected.unregister(input_fd)

        while True:
            if stopping is not None and time.monotonic() >= stopping:
                kill_group(signal.SIGKILL)
                stopping = None
            descendants_pending = False
            if process.poll() is not None:
                kill_group(signal.SIGKILL)
                descendants_pending = stop_adopted_children()
                if descendants_pending:
                    if descendant_deadline is None:
                        descendant_deadline = time.monotonic() + 2
                    elif time.monotonic() >= descendant_deadline:
                        raise ChannelError("PROCESS_CLEANUP_FAILED")
            if not outputs and process.poll() is not None and not descendants_pending:
                emit({"kind": "exit", "exitCode": process.returncode})
                return
            for key, events in selected.select(0.1):
                if key.data in ("input", "pty") and events & selectors.EVENT_WRITE and pending_input is not None:
                    request_id, data, offset = pending_input
                    try:
                        count = os.write(input_fd, data[offset:])
                    except OSError as error:
                        if error.errno not in (errno.EPIPE, errno.EIO):
                            raise
                        if stopping is None and process.poll() is None:
                            raise ChannelError("INPUT_CLOSED")
                        input_poll(False)
                        pending_input = None
                        continue
                    offset += count
                    if offset == len(data):
                        input_poll(False)
                        pending_input = None
                        emit({"kind": "ack", "id": request_id})
                    else:
                        pending_input = (request_id, data, offset)
                if key.data in ("stdout", "stderr", "pty") and events & selectors.EVENT_READ:
                    try:
                        chunk = os.read(key.fd, CHUNK_SIZE)
                    except OSError as error:
                        if key.data != "pty" or error.errno != errno.EIO:
                            raise
                        chunk = b""
                    name = "stdout" if key.data == "pty" else key.data
                    if chunk:
                        emit({"kind": name, "bytes": base64.b64encode(chunk).decode("ascii")})
                    else:
                        selected.unregister(key.fd)
                        outputs.pop(name)
                        if key.data == "pty":
                            pending_input = None
                            input_open = False
                elif key.data == "control":
                    chunk = os.read(0, FRAME_LIMIT)
                    if not chunk:
                        raise ChannelError("CANCELLED")
                    incoming.extend(chunk)
                    while b"\n" in incoming:
                        line, _, remainder = incoming.partition(b"\n")
                        incoming = bytearray(remainder)
                        if len(line) > FRAME_LIMIT:
                            raise ChannelError("FRAME_LIMIT")
                        event = json.loads(line)
                        if event["kind"] == "input":
                            if pending_input is not None or not input_open:
                                raise ChannelError("INVALID_REQUEST")
                            data = base64.b64decode(event["bytes"], validate=True)
                            if len(data) > CHUNK_SIZE:
                                raise ChannelError("FRAME_LIMIT")
                            if not data:
                                emit({"kind": "ack", "id": event["id"]})
                            else:
                                pending_input = (event["id"], data, 0)
                                input_poll(True)
                        elif event["kind"] == "resize":
                            resize(event["cols"], event["rows"])
                            emit({"kind": "ack", "id": event["id"]})
                        elif event["kind"] == "end":
                            if master is not None:
                                raise ChannelError("PTY_INPUT_NOT_CLOSABLE")
                            if pending_input is not None:
                                raise ChannelError("INVALID_REQUEST")
                            process.stdin.close()
                            input_open = False
                        elif event["kind"] == "stop":
                            if pending_input is not None:
                                input_poll(False)
                                pending_input = None
                            if master is None and not process.stdin.closed:
                                process.stdin.close()
                            input_open = False
                            kill_group(signal.SIGTERM)
                            stopping = time.monotonic() + 2
                        else:
                            raise ChannelError("INVALID_REQUEST")
                    if len(incoming) > FRAME_LIMIT:
                        raise ChannelError("FRAME_LIMIT")


try:
    run()
except ChannelError as error:
    emit({"kind": "error", "code": error.code, "effect": "unknown" if process is not None else "not-applied"})
except OSError as error:
    emit({"kind": "error", "code": errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED"), "effect": "unknown" if process is not None else "not-applied"})
except Exception:
    emit({"kind": "error", "code": "INVALID_REQUEST", "effect": "unknown" if process is not None else "not-applied"})
finally:
    if process is not None:
        for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
        try:
            finish_children()
        except ChannelError as error:
            emit({"kind": "error", "code": error.code, "effect": "unknown"})
        except OSError as error:
            emit({"kind": "error", "code": errno.errorcode.get(error.errno, "PROCESS_CLEANUP_FAILED"), "effect": "unknown"})
        for name in ("stdin", "stdout", "stderr"):
            stream = getattr(process, name)
            if stream is not None and not stream.closed:
                stream.close()
    if master is not None:
        os.close(master)
