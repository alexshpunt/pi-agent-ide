"""Windows channel: pipe services and ConPTY sessions, owned by a Job Object.

Pipes on Windows cannot be polled with selectors, so one thread drains each stream and the
main thread owns all framing. A PTY session runs behind a pseudoconsole (ConPTY) and is
presented to the same loop as one merged output stream and one input stream. Every process
starts inside the Job Object, so no descendant escapes before it is assigned.
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

from ssh_channel_common import CHUNK_SIZE, FRAME_LIMIT, INPUT_WINDOW, ChannelError, command_line, emit, error_code, initial_request
from ssh_paths import InvalidPath, windows_native

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
HANDLEP = ctypes.POINTER(wintypes.HANDLE)

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
kernel32.CreatePipe.restype = wintypes.BOOL
kernel32.CreatePipe.argtypes = [HANDLEP, HANDLEP, wintypes.LPVOID, wintypes.DWORD]
kernel32.ReadFile.restype = wintypes.BOOL
kernel32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
kernel32.WriteFile.restype = wintypes.BOOL
kernel32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
kernel32.GetExitCodeProcess.restype = wintypes.BOOL
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL
kernel32.InitializeProcThreadAttributeList.argtypes = [wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL
kernel32.UpdateProcThreadAttribute.argtypes = [
    wintypes.LPVOID, wintypes.DWORD, ctypes.c_size_t, wintypes.LPVOID, ctypes.c_size_t, wintypes.LPVOID, wintypes.LPVOID]
kernel32.DeleteProcThreadAttributeList.restype = None
kernel32.DeleteProcThreadAttributeList.argtypes = [wintypes.LPVOID]
ntdll.NtResumeProcess.restype = ctypes.c_long
ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
CREATE_SUSPENDED = 0x4
EXTENDED_STARTUPINFO_PRESENT = 0x80000
STARTF_USESTDHANDLES = 0x100
PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x20016
STILL_ACTIVE = 259
ERROR_BROKEN_PIPE = 109
ERROR_NO_DATA = 232


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


class Coord(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE),
    ]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
    ]


kernel32.CreateProcessW.restype = wintypes.BOOL
kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID, wintypes.BOOL, wintypes.DWORD,
    wintypes.LPVOID, wintypes.LPCWSTR, ctypes.POINTER(StartupInfoEx), ctypes.POINTER(ProcessInformation)]


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
        checked(kernel32.AssignProcessToJobObject(self.handle, int(child._handle)))

    def terminate(self):
        kernel32.TerminateJobObject(self.handle, 1)

    def close(self):
        kernel32.CloseHandle(self.handle)


class PtyOutput:
    """The pseudoconsole's output pipe, read like a pipe stream."""

    def __init__(self, handle):
        self.handle = handle

    def read1(self, size):
        buffer = ctypes.create_string_buffer(size)
        count = wintypes.DWORD()
        if not kernel32.ReadFile(self.handle, buffer, size, ctypes.byref(count), None):
            if ctypes.get_last_error() in (ERROR_BROKEN_PIPE, ERROR_NO_DATA):
                return b""
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.raw[:count.value]


class PtyInput:
    """The pseudoconsole's input pipe. Control keys such as Ctrl+C travel as ordinary bytes."""

    def __init__(self, handle):
        self.handle = handle
        self.closed = False

    def write(self, data):
        view = memoryview(data)
        while len(view):
            count = wintypes.DWORD()
            checked(kernel32.WriteFile(self.handle, bytes(view), len(view), ctypes.byref(count), None))
            view = view[count.value:]

    def flush(self):
        pass

    def close(self):
        if not self.closed:
            self.closed = True
            kernel32.CloseHandle(self.handle)


class PtyProcess:
    """A process attached to a ConPTY and started directly inside the job."""

    def __init__(self, argv, cwd, cols, rows, job):
        try:
            self.console = kernel32.CreatePseudoConsole
        except AttributeError:
            raise ChannelError("CAPABILITY_UNAVAILABLE")
        self.console.restype = ctypes.c_long
        self.console.argtypes = [Coord, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD, HANDLEP]
        kernel32.ResizePseudoConsole.restype = ctypes.c_long
        kernel32.ResizePseudoConsole.argtypes = [wintypes.HANDLE, Coord]
        kernel32.ClosePseudoConsole.restype = None
        kernel32.ClosePseudoConsole.argtypes = [wintypes.HANDLE]
        # A worker started with Ctrl+C ignored would pass that on, and Ctrl+C typed into the
        # session would then never reach the shell. Restore normal handling for the children.
        kernel32.SetConsoleCtrlHandler(None, False)
        self.returncode = None
        self.pty_closed = False
        self.hpc = wintypes.HANDLE()
        input_read, input_write = wintypes.HANDLE(), wintypes.HANDLE()
        output_read, output_write = wintypes.HANDLE(), wintypes.HANDLE()
        checked(kernel32.CreatePipe(ctypes.byref(input_read), ctypes.byref(input_write), None, 0))
        checked(kernel32.CreatePipe(ctypes.byref(output_read), ctypes.byref(output_write), None, 0))
        self.stdin = PtyInput(input_write)
        self.stdout = PtyOutput(output_read)
        try:
            status = self.console(Coord(cols, rows), input_read, output_write, 0, ctypes.byref(self.hpc))
            if status < 0:
                raise OSError(0, "CreatePseudoConsole failed: 0x%08x" % (status & 0xFFFFFFFF))
        finally:
            # The pseudoconsole owns duplicates; keeping these open would block end-of-output.
            kernel32.CloseHandle(input_read)
            kernel32.CloseHandle(output_write)
        try:
            self.process_handle, self.pid = self.spawn(argv, cwd, job)
        except BaseException:
            self.close_console()
            self.stdin.close()
            raise

    def spawn(self, argv, cwd, job):
        size = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        attributes = ctypes.create_string_buffer(size.value)
        checked(kernel32.InitializeProcThreadAttributeList(attributes, 2, 0, ctypes.byref(size)))
        try:
            # Starting inside the job leaves no window for a descendant to escape it.
            jobs = (wintypes.HANDLE * 1)(job.handle)
            checked(kernel32.UpdateProcThreadAttribute(
                attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, ctypes.byref(jobs), ctypes.sizeof(jobs), None, None))
            checked(kernel32.UpdateProcThreadAttribute(
                attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, self.hpc, ctypes.sizeof(wintypes.HANDLE), None, None))
            startup = StartupInfoEx()
            startup.StartupInfo.cb = ctypes.sizeof(startup)
            # The worker's own stdio is redirected; null standard handles make the child use the
            # pseudoconsole instead of inheriting them.
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
            startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
            information = ProcessInformation()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
            checked(kernel32.CreateProcessW(
                None, command, None, None, False, EXTENDED_STARTUPINFO_PRESENT, None, cwd,
                ctypes.byref(startup), ctypes.byref(information)))
        finally:
            kernel32.DeleteProcThreadAttributeList(attributes)
        kernel32.CloseHandle(information.hThread)
        return information.hProcess, information.dwProcessId

    def poll(self):
        if self.returncode is None:
            code = wintypes.DWORD()
            checked(kernel32.GetExitCodeProcess(self.process_handle, ctypes.byref(code)))
            if code.value != STILL_ACTIVE:
                self.returncode = code.value
        return self.returncode

    def resize(self, cols, rows):
        status = kernel32.ResizePseudoConsole(self.hpc, Coord(cols, rows))
        if status < 0:
            raise OSError(0, "ResizePseudoConsole failed: 0x%08x" % (status & 0xFFFFFFFF))

    def close_console(self):
        """Closing flushes the final output and then ends the output pipe."""
        if self.pty_closed or not self.hpc:
            return
        self.pty_closed = True
        # Older Windows blocks until the output is drained, which the reader thread does.
        threading.Thread(target=kernel32.ClosePseudoConsole, args=(self.hpc,), daemon=True).start()


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
    dimensions = request.get("pty")
    # `python3` on Windows may be the Store alias; reuse the interpreter that runs this worker.
    argv, preamble = command_line(request, sys.executable)
    if "command" in request:
        # CreateProcess ignores PATHEXT, so npm shims such as `server.cmd` need the lookup.
        argv = resolve_argv(argv)
    try:
        cwd = windows_native(request["cwd"])
    except InvalidPath:
        raise ChannelError("INVALID_PATH")
    job = Job()
    if dimensions is None:
        process = subprocess.Popen(
            argv, cwd=cwd,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW | CREATE_SUSPENDED,
        )
        # Suspended until assigned, so no descendant can start outside the job.
        job.assign(process)
        checked(ntdll.NtResumeProcess(int(process._handle)) >= 0)
        if preamble:
            # The worker reads its whole program before it reads caller input or writes output.
            process.stdin.write(preamble)
            process.stdin.flush()
        outputs = {"stdout", "stderr"}
    else:
        if preamble:
            raise ChannelError("INVALID_REQUEST")
        process = PtyProcess(argv, cwd, dimensions["cols"], dimensions["rows"], job)
        outputs = {"stdout"}
    emit({"kind": "ready", "pid": process.pid})
    events = queue.Queue()
    inputs = queue.Queue()
    for name in outputs:
        start(drain, getattr(process, name), name, events)
    start(control, events)
    start(deliver, process.stdin, inputs, events)
    incoming = bytearray()
    # Ids of input frames handed to the delivery thread and not yet written.
    pending_inputs = set()
    input_open = True
    stopping = False
    leader_exited = False
    while True:
        if not leader_exited and process.poll() is not None:
            # Like the POSIX process group, descendants end with the leader.
            leader_exited = True
            job.terminate()
            if dimensions is not None:
                process.close_console()
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
                if dimensions is not None:
                    pending_inputs.clear()
                    input_open = False
        elif kind == "ack":
            pending_inputs.discard(value)
            emit({"kind": "ack", "id": value})
        elif kind == "input-failed":
            pending_inputs.discard(value)
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
                        pending_inputs.add(event["id"])
                        inputs.put((event["id"], data))
                elif event["kind"] == "resize":
                    if dimensions is None:
                        raise ChannelError("PTY_REQUIRED")
                    process.resize(event["cols"], event["rows"])
                    emit({"kind": "ack", "id": event["id"]})
                elif event["kind"] == "end":
                    if dimensions is not None:
                        raise ChannelError("PTY_INPUT_NOT_CLOSABLE")
                    if pending_inputs:
                        raise ChannelError("INVALID_REQUEST")
                    if input_open:
                        input_open = False
                        inputs.put(None)
                elif event["kind"] == "stop":
                    if input_open and dimensions is None:
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
