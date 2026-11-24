"""Relay a Win32 DAP named pipe after checking its exact server process identity."""
import _winapi
import ctypes
import msvcrt
import os
import sys
import threading
import time
from ctypes import wintypes

from pi_windows_process import identity, read_pid

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.GetNamedPipeServerProcessId.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
kernel32.GetNamedPipeServerProcessId.restype = wintypes.BOOL

GENERIC_READ_WRITE = 0xC0000000
FILE_FLAG_OVERLAPPED = 0x40000000
SECURITY_IDENTIFICATION = 0x10000
SECURITY_SQOS_PRESENT = 0x100000
ERROR_FILE_NOT_FOUND = 2
ERROR_PIPE_BUSY = 231
PIPE_CLOSED = (109, 232, 233)
CHUNK = 16384


def connect(name, pid, expected):
    deadline = time.monotonic() + 30
    while True:
        if read_pid(pid, identity) != expected:
            raise RuntimeError("Peer identity changed")
        try:
            handle = _winapi.CreateFile(
                name, GENERIC_READ_WRITE, 0, _winapi.NULL, _winapi.OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, 0,
            )
            break
        except OSError as error:
            if error.winerror not in (ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY) or time.monotonic() >= deadline:
                raise
            time.sleep(0.025)
    peer = wintypes.ULONG()
    if not kernel32.GetNamedPipeServerProcessId(handle, ctypes.byref(peer)) or peer.value != pid or read_pid(pid, identity) != expected:
        raise RuntimeError("Pipe belongs to another process")
    return handle


def input_to_pipe(handle):
    try:
        while True:
            data = memoryview(os.read(0, CHUNK))
            if not data:
                break
            while data:
                operation, _ = _winapi.WriteFile(handle, data, True)
                count, error = operation.GetOverlappedResult(True)
                if error or not count:
                    os._exit(0 if error in PIPE_CLOSED else 1)
                data = data[count:]
    except OSError as error:
        os._exit(0 if error.winerror in PIPE_CLOSED else 1)
    # Closing the DAP stream ends the relay; Windows named pipes do not have half-close.
    os._exit(0)


def run():
    name, native_pid, expected = sys.argv[1:]
    msvcrt.setmode(0, os.O_BINARY)
    msvcrt.setmode(1, os.O_BINARY)
    handle = connect(name, int(native_pid), expected)
    threading.Thread(target=input_to_pipe, args=(handle,), daemon=True).start()
    while True:
        operation, _ = _winapi.ReadFile(handle, CHUNK, True)
        count, error = operation.GetOverlappedResult(True)
        if error in PIPE_CLOSED:
            return
        if error:
            raise ctypes.WinError(error)
        if not count:
            return
        buffer = operation.getbuffer()
        if buffer is None:
            raise RuntimeError("Missing completed read buffer")
        data = memoryview(buffer)[:count]
        while data:
            data = data[os.write(1, data):]


try:
    run()
except OSError as error:
    os._exit(0 if error.winerror in PIPE_CLOSED else 1)
except Exception:
    # Native paths and adapter diagnostics stay on the owning target.
    os._exit(1)
# The OS cancels outstanding reads and writes and closes the pipe when this worker exits.
os._exit(0)
