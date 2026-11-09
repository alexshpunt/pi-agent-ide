"""Windows pipe channel: reader threads and a Job Object that owns the process tree.

Pipes on Windows cannot be polled with selectors, so one thread drains each stream and the
main thread owns all framing. PTY sessions are not available on Windows targets yet.
"""
import base64
import ctypes
import errno
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
from ctypes import wintypes

from ssh_channel_common import CHUNK_SIZE, FRAME_LIMIT, ChannelError, command_line, emit, error_code, initial_request
from ssh_paths import InvalidPath, windows_native

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
kernel32.SetInformationJobObject.restype = wintypes.BOOL
kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.TerminateJobObject.restype = wintypes.BOOL
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimits),
        ("IoInfo", IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def checked(result):
    if not result:
        raise ctypes.WinError(ctypes.get_last_error())
    return result


class Job:
    """Closing the last handle, including when this worker dies, ends every assigned process."""

    def __init__(self):
        self.handle = checked(kernel32.CreateJobObjectW(None, None))
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel32.SetInformationJobObject(
            self.handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(limits), ctypes.sizeof(limits)))

    def assign(self, child):
        # Descendants started before assignment escape the job; ConPTY work replaces this
        # with suspended creation.
        checked(kernel32.AssignProcessToJobObject(self.handle, int(child._handle)))

    def terminate(self):
        kernel32.TerminateJobObject(self.handle, 1)

    def close(self):
        kernel32.CloseHandle(self.handle)


process = None
job = None

# npm, pnpm and Yarn shims end with: "%_prog%"  "%dp0%\node_modules\pkg\bin\tool" %*
SHIM_TARGET = re.compile(r'"%_prog%"\s+(?:\S+\s+)*?"%dp0%\\(?P<script>[^"]+)"\s+%\*', re.IGNORECASE)
BATCH_UNSAFE = re.compile(r'[%^&|<>"!\r\n]')


def resolve_argv(argv):
    """Find the executable the way a shell does: PATH and PATHEXT, without the current directory.

    CreateProcess only starts `.exe` files by bare name, so tools installed as `.cmd` shims
    (npm packages) would be missing. A shim that just starts a Node script runs that script
    directly. Any other batch file goes through cmd.exe, which cannot quote arguments safely,
    so arguments with batch metacharacters are refused.
    """
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    found = shutil.which(argv[0])
    if found is None:
        raise FileNotFoundError(errno.ENOENT, "command not found", argv[0])
    if not found.lower().endswith((".cmd", ".bat")):
        return [found, *argv[1:]]
    directory = os.path.dirname(found)
    with open(found, "r", encoding="utf8", errors="replace") as shim:
        match = SHIM_TARGET.search(shim.read())
    if match is not None:
        script = os.path.join(directory, match.group("script"))
        node = os.path.join(directory, "node.exe")
        node = node if os.path.exists(node) else shutil.which("node")
        if node is not None and os.path.exists(script):
            return [node, script, *argv[1:]]
    if any(BATCH_UNSAFE.search(argument) for argument in argv[1:]):
        raise ChannelError("INVALID_REQUEST")
    return [found, *argv[1:]]


def drain(stream, name, events):
    try:
        while True:
            chunk = stream.read1(CHUNK_SIZE)
            events.put((name, chunk))
            if not chunk:
                return
    except (OSError, ValueError):
        events.put((name, b""))


def control(events):
    try:
        while True:
            chunk = os.read(0, FRAME_LIMIT)
            events.put(("control", chunk))
            if not chunk:
                return
    except OSError:
        events.put(("control", b""))


def deliver(stdin, inputs, events):
    while True:
        item = inputs.get()
        if item is None:
            try:
                stdin.close()
            except OSError:
                pass
            return
        request_id, data = item
        try:
            stdin.write(data)
            stdin.flush()
        except (OSError, ValueError):
            events.put(("input-failed", request_id))
            continue
        events.put(("ack", request_id))


def start(target, *args):
    threading.Thread(target=target, args=args, daemon=True).start()


def run():
    global process, job
    request = initial_request()
    if request.get("pty") is not None:
        raise ChannelError("CAPABILITY_UNAVAILABLE")
    # `python3` on Windows may be the Store alias; reuse the interpreter that runs this worker.
    argv, preamble = command_line(request, sys.executable)
    try:
        cwd = windows_native(request["cwd"])
    except InvalidPath:
        raise ChannelError("INVALID_PATH")
    job = Job()
    if "python" not in request:
        argv = resolve_argv(argv)
    process = subprocess.Popen(
        argv, cwd=cwd,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
    )
    job.assign(process)
    if preamble:
        # The worker reads its whole program before it reads caller input or writes output.
        process.stdin.write(preamble)
        process.stdin.flush()
    emit({"kind": "ready", "pid": process.pid})
    events = queue.Queue()
    inputs = queue.Queue()
    start(drain, process.stdout, "stdout", events)
    start(drain, process.stderr, "stderr", events)
    start(control, events)
    start(deliver, process.stdin, inputs, events)
    outputs = {"stdout", "stderr"}
    incoming = bytearray()
    pending_input = False
    input_open = True
    stopping = False
    leader_exited = False
    while True:
        if not leader_exited and process.poll() is not None:
            # Like the POSIX process group, descendants end with the leader.
            leader_exited = True
            job.terminate()
        if not outputs and leader_exited:
            emit({"kind": "exit", "exitCode": process.returncode})
            return
        try:
            kind, value = events.get(timeout=0.1)
        except queue.Empty:
            continue
        if kind in ("stdout", "stderr"):
            if value:
                emit({"kind": kind, "bytes": base64.b64encode(value).decode("ascii")})
            else:
                outputs.discard(kind)
        elif kind == "ack":
            pending_input = False
            emit({"kind": "ack", "id": value})
        elif kind == "input-failed":
            pending_input = False
            if not stopping and process.poll() is None:
                raise ChannelError("INPUT_CLOSED")
        elif kind == "control":
            if not value:
                raise ChannelError("CANCELLED")
            incoming.extend(value)
            while b"\n" in incoming:
                line, _, remainder = incoming.partition(b"\n")
                incoming = bytearray(remainder)
                if len(line) > FRAME_LIMIT:
                    raise ChannelError("FRAME_LIMIT")
                event = json.loads(line)
                if event["kind"] == "input":
                    if pending_input or not input_open:
                        raise ChannelError("INVALID_REQUEST")
                    data = base64.b64decode(event["bytes"], validate=True)
                    if len(data) > CHUNK_SIZE:
                        raise ChannelError("FRAME_LIMIT")
                    if not data:
                        emit({"kind": "ack", "id": event["id"]})
                    else:
                        pending_input = True
                        inputs.put((event["id"], data))
                elif event["kind"] == "resize":
                    raise ChannelError("PTY_REQUIRED")
                elif event["kind"] == "end":
                    if pending_input:
                        raise ChannelError("INVALID_REQUEST")
                    if input_open:
                        input_open = False
                        inputs.put(None)
                elif event["kind"] == "stop":
                    if input_open:
                        input_open = False
                        inputs.put(None)
                    stopping = True
                    job.terminate()
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
        if job is not None:
            job.terminate()
            job.close()
    # Reader threads may still block on pipes; they must not delay the exit.
    os._exit(0)
