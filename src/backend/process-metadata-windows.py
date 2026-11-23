"""Read identity from one Win32 process handle, without enumerating processes."""
import ctypes
import datetime
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
FILETIMEP = ctypes.POINTER(wintypes.FILETIME)
DWORDP = ctypes.POINTER(wintypes.DWORD)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE, FILETIMEP, FILETIMEP, FILETIMEP, FILETIMEP]
kernel32.GetProcessTimes.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, DWORDP]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x100000
ERROR_INVALID_PARAMETER = 87
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258


class ProcessBasicInformation(ctypes.Structure):
    _fields_ = [
        ("reserved1", ctypes.c_void_p),
        ("peb", ctypes.c_void_p),
        ("reserved2", ctypes.c_void_p * 2),
        ("pid", ctypes.c_size_t),
        ("parent_pid", ctypes.c_size_t),
    ]


ntdll.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, DWORDP]
ntdll.NtQueryInformationProcess.restype = ctypes.c_long


def created_at(handle):
    created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
    if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def identity(handle):
    # Use the same format as the channel ready frame. A handle pins the original process.
    return "f11e:" + str(created_at(handle))


def read_pid(pid, inspect):
    if not 0 < pid <= 0xFFFFFFFF:
        raise ProcessLookupError()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        if error == ERROR_INVALID_PARAMETER:
            raise ProcessLookupError()
        raise ctypes.WinError(error)
    try:
        result = inspect(handle)
        status = kernel32.WaitForSingleObject(handle, 0)
        if status == WAIT_OBJECT_0:
            raise ProcessLookupError()
        if status != WAIT_TIMEOUT:
            raise ctypes.WinError(ctypes.get_last_error())
        return result
    finally:
        kernel32.CloseHandle(handle)


def metadata(pid):
    def inspect(handle):
        ticks = created_at(handle)
        started = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(microseconds=ticks // 10)
        name = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(name))
        executable = name.value if kernel32.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)) else None
        info = ProcessBasicInformation()
        status = ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info), None)
        return {"pid": pid, "parentPid": info.parent_pid if status >= 0 else 0,
                "command": executable or "", "started": started.isoformat(),
                "identity": "f11e:" + str(ticks), "executable": executable}
    return read_pid(pid, inspect)
