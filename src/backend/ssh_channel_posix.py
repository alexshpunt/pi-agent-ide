"""POSIX pipe/PTY channel: process groups, a child subreaper and Linux /proc metadata."""
import base64
from collections import deque
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import termios
import time

from ssh_channel_common import CHUNK_SIZE, FRAME_LIMIT, INPUT_WINDOW, ChannelError, command_line, emit, error_code, initial_request

process = None
master = None


def interrupted(_signum, _frame):
    raise ChannelError("CANCELLED")


for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, interrupted)


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


def adopted_children():
    # Read only our direct kernel children, not a system-wide ancestry snapshot.
    directory = "/proc/self/task/" + str(os.getpid()) + "/children"
    with open(directory, encoding="utf-8") as stream:
        children = [int(value) for value in stream.read().split()]
    # The command's own status belongs to subprocess, so it is never collected here.
    return [pid for pid in children if process is None or pid != process.pid]


def reap_adopted_children():
    # An exited orphan stays a zombie until its subreaper collects it; a PID-namespace init such as
    # bwrap cannot finish while one of its former members waits here.
    for pid in adopted_children():
        os.waitpid(pid, os.WNOHANG)


def stop_adopted_children():
    pending = False
    for pid in adopted_children():
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
    # PATH resolves python3 as the bootstrap did, so target-side wrappers apply to workers too.
    argv, preamble = command_line(request, "python3")
    if dimensions is None:
        process = subprocess.Popen(
            argv, cwd=request["cwd"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        if preamble:
            # The worker reads its whole program before it reads caller input or writes output.
            process.stdin.write(preamble)
            process.stdin.flush()
        input_fd = process.stdin.fileno()
        outputs = {name: getattr(process, name).fileno() for name in ("stdout", "stderr")}
    else:
        if preamble:
            raise ChannelError("INVALID_REQUEST")
        master, slave = pty.openpty()
        try:
            resize(dimensions["cols"], dimensions["rows"])
            process = subprocess.Popen(
                argv, cwd=request["cwd"],
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
    # Input frames in arrival order: [request id, bytes, bytes already written].
    pending_inputs = deque()
    stopping = None
    descendant_deadline = None
    next_reap = 0
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
            if process.poll() is None:
                if time.monotonic() >= next_reap:
                    reap_adopted_children()
                    next_reap = time.monotonic() + 0.25
            else:
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
                if key.data in ("input", "pty") and events & selectors.EVENT_WRITE and pending_inputs:
                    request_id, data, offset = pending_inputs[0]
                    try:
                        count = os.write(input_fd, data[offset:])
                    except OSError as error:
                        if error.errno not in (errno.EPIPE, errno.EIO):
                            raise
                        if stopping is None and process.poll() is None:
                            raise ChannelError("INPUT_CLOSED")
                        input_poll(False)
                        pending_inputs.clear()
                        continue
                    offset += count
                    if offset == len(data):
                        pending_inputs.popleft()
                        if not pending_inputs:
                            input_poll(False)
                        emit({"kind": "ack", "id": request_id})
                    else:
                        pending_inputs[0][2] = offset
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
                            pending_inputs.clear()
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
                            if not input_open:
                                raise ChannelError("INVALID_REQUEST")
                            if len(pending_inputs) >= INPUT_WINDOW:
                                raise ChannelError("INPUT_LIMIT")
                            data = base64.b64decode(event["bytes"], validate=True)
                            if len(data) > CHUNK_SIZE:
                                raise ChannelError("FRAME_LIMIT")
                            if not data:
                                emit({"kind": "ack", "id": event["id"]})
                            else:
                                if not pending_inputs:
                                    input_poll(True)
                                pending_inputs.append([event["id"], data, 0])
                        elif event["kind"] == "resize":
                            resize(event["cols"], event["rows"])
                            emit({"kind": "ack", "id": event["id"]})
                        elif event["kind"] == "end":
                            if master is not None:
                                raise ChannelError("PTY_INPUT_NOT_CLOSABLE")
                            if pending_inputs:
                                raise ChannelError("INVALID_REQUEST")
                            process.stdin.close()
                            input_open = False
                        elif event["kind"] == "stop":
                            if pending_inputs:
                                input_poll(False)
                                pending_inputs.clear()
                            if master is None and not process.stdin.closed:
                                process.stdin.close()
                            input_open = False
                            kill_group(signal.SIGTERM)
                            stopping = time.monotonic() + 2
                        else:
                            raise ChannelError("INVALID_REQUEST")
                    if len(incoming) > FRAME_LIMIT:
                        raise ChannelError("FRAME_LIMIT")


def main():
    try:
        run()
    except ChannelError as error:
        emit({"kind": "error", "code": error.code, "effect": "unknown" if process is not None else "not-applied"})
    except OSError as error:
        emit({"kind": "error", "code": error_code(error), "effect": "unknown" if process is not None else "not-applied"})
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
