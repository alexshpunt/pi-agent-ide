"""Allocate and clean up Doctor's Windows probe copies without following reparse points."""
import contextlib
import ctypes
from ctypes import wintypes
import errno
import json
import os
import queue
import stat
import sys
import tempfile
import threading

from ssh_paths import windows_native, windows_wire  # pyright: ignore[reportImplicitRelativeImport]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.GetFileInformationByHandleEx.restype = wintypes.BOOL
kernel32.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.SetFileInformationByHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
FILE_READ_ATTRIBUTES = 0x80
DELETE = 0x10000
FILE_SHARE_READ_WRITE = 0x3
OPEN_EXISTING = 3
BACKUP_SEMANTICS = 0x02000000
OPEN_REPARSE_POINT = 0x00200000
FILE_ATTRIBUTE_TAG_INFO = 9
FILE_ID_INFO = 18
FILE_DISPOSITION_INFO_EX = 21
DISPOSITION_DELETE = 0x1
DISPOSITION_IGNORE_READONLY = 0x10
ERROR_DIR_NOT_EMPTY = 145
PREFIX = ".pi-agent-ide-doctor-"


class FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]


class FileIdInfo(ctypes.Structure):
    _fields_ = [("volume", ctypes.c_uint64), ("file_id", ctypes.c_ubyte * 16)]


def native(path):
    result = windows_native(path)
    return "\\\\?\\" + result if len(result) >= 240 else result


@contextlib.contextmanager
def locked(path, directory, expected=None, delete=False):
    # Excluding FILE_SHARE_DELETE prevents a checked entry from being renamed or replaced
    # while we use it. Parent directories are held while creating and removing children.
    handle = kernel32.CreateFileW(path, FILE_READ_ATTRIBUTES | (DELETE if delete else 0),
                                  FILE_SHARE_READ_WRITE, None, OPEN_EXISTING,
                                  BACKUP_SEMANTICS | OPEN_REPARSE_POINT, None)
    if handle in (None, INVALID_HANDLE_VALUE):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = FileAttributeTagInfo()
        file_id = FileIdInfo()
        if not kernel32.GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO,
                                                      ctypes.byref(attributes), ctypes.sizeof(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.GetFileInformationByHandleEx(handle, FILE_ID_INFO, ctypes.byref(file_id), ctypes.sizeof(file_id)):
            raise ctypes.WinError(ctypes.get_last_error())
        current = str(file_id.volume), str(int.from_bytes(file_id.file_id, "little"))
        if (current[1] == "0" or attributes.attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT or
                bool(attributes.attributes & stat.FILE_ATTRIBUTE_DIRECTORY) != directory or
                (expected is not None and current != expected)):
            raise ValueError()
        yield handle, current
    finally:
        kernel32.CloseHandle(handle)


def remove_locked(handle, allow_nonempty=False):
    flags = wintypes.DWORD(DISPOSITION_DELETE | DISPOSITION_IGNORE_READONLY)
    if not kernel32.SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_EX,
                                               ctypes.byref(flags), ctypes.sizeof(flags)):
        code = ctypes.get_last_error()
        if not (allow_nonempty and code == ERROR_DIR_NOT_EMPTY):
            raise ctypes.WinError(code)


def remove_container(data):
    container = native(data["container"])
    if os.path.basename(container) != ".tmp":
        raise ValueError()
    with locked(container, True, (data["device"], data["inode"]), delete=True) as (handle, _):
        remove_locked(handle, allow_nonempty=True)


def remove_probe(data):
    directory = native(data["directory"])
    name = os.path.basename(directory)
    container = os.path.dirname(directory)
    probe = data["name"]
    if (not name.startswith(PREFIX) or os.path.basename(container) != ".tmp" or
            probe in ("", ".", "..") or os.path.basename(probe) != probe or ":" in probe):
        raise ValueError()
    expected = data["device"], data["inode"]
    with locked(container, True, (data["containerDevice"], data["containerInode"])):
        with locked(directory, True, expected):
            entries = os.listdir(directory)
            if any(entry != probe for entry in entries):
                raise ValueError()
            if entries:
                with locked(os.path.join(directory, probe), False, delete=True) as (file_handle, _):
                    remove_locked(file_handle)
        # Windows directory enumeration may open a handle without sharing deletion.
        # Release the enumeration guard first, then revalidate the identity when claiming DELETE.
        with locked(directory, True, expected, delete=True) as (handle, _):
            remove_locked(handle)


def wait_for_retain():
    # Windows select() cannot wait on anonymous pipes. The reader does not keep the process alive.
    answer = queue.Queue(maxsize=1)
    threading.Thread(target=lambda: answer.put(sys.stdin.buffer.readline(32)), daemon=True).start()
    try:
        return answer.get(timeout=5) in (b"retain\n", b"retain\r\n")
    except queue.Empty:
        return False


def create_probe(data):
    source = native(data["source"])
    parent = os.path.dirname(source)
    container = os.path.join(parent, ".tmp")
    container_wire = windows_wire(container)
    created = False
    container_identity = None
    entry = None
    receipt = None
    retained = False
    with locked(parent, True):
        try:
            try:
                os.mkdir(container, 0o700)
                created = True
            except OSError as error:
                if error.errno != errno.EEXIST:
                    raise
            with locked(container, True) as (_, container_identity):
                container_device, container_inode = container_identity
                entry = tempfile.mkdtemp(prefix=PREFIX, dir=container)
                with locked(entry, True) as (_, (device, inode)):
                    pass
                receipt = {"directory": windows_wire(entry), "device": device, "inode": inode,
                           "containerCreated": created, "containerDevice": container_device,
                           "containerInode": container_inode}
                print(json.dumps(receipt), flush=True)
                retained = wait_for_retain()
                if not retained:
                    raise ValueError()
        finally:
            if not retained:
                try:
                    if receipt is not None:
                        remove_probe({**receipt, "name": os.path.basename(source)})
                    elif entry is not None:
                        # An entry whose identity was never recorded is unsafe to remove.
                        raise ValueError()
                    if created:
                        if container_identity is None:
                            raise ValueError()
                        remove_container({"container": container_wire, "device": container_identity[0],
                                          "inode": container_identity[1]})
                except Exception:
                    print(json.dumps({"error": "PROBE_CLEANUP_FAILED"}), flush=True)
                    # A daemon may be blocked in stdin; avoid its interpreter shutdown lock.
                    os._exit(2)


request = json.loads(sys.argv[1])
operation = request["operation"]
try:
    if operation == "create":
        create_probe(request)
    elif operation == "remove-container":
        remove_container(request)
        print("null")
    elif operation == "remove":
        remove_probe(request)
        print("null")
    else:
        raise ValueError()
except Exception:
    print(json.dumps({"error": "PROBE_FAILED"}), flush=True)
    if operation == "create":
        os._exit(1)
