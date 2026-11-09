"""Windows file primitives shared by the file-operation and transfer workers.

Writers are serialized with named kernel mutexes. A file is replaced with ReplaceFileW, which
keeps the replaced file's attributes, ACL, alternate streams and creation time.
"""
import contextlib
import ctypes
import hashlib
import json
import os
import stat
from ctypes import wintypes

from ssh_paths import InvalidPath, windows_native, windows_wire

FILE_ATTRIBUTE_READONLY = 0x1
FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_NORMAL = 0x80
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
# Hidden, system, archive and not-content-indexed travel with a copied file.
COPIED_ATTRIBUTES = 0x2 | 0x4 | 0x20 | 0x2000
IO_REPARSE_TAGS = (0xA0000003, 0xA000000C)  # junction (mount point) and symbolic link
LOCK_TIMEOUT_MS = 20000
LONG_PATH = 240

ERROR_ACCESS_DENIED = 5
ERROR_SHARING_VIOLATION = 32
ERROR_LOCK_VIOLATION = 33
ERROR_FILE_EXISTS = 80
ERROR_PRIVILEGE_NOT_HELD = 1314
ERROR_UNABLE_TO_REMOVE_REPLACED = 1175
ERROR_UNABLE_TO_MOVE_REPLACEMENT = 1176
ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 = 1177


class Failure(Exception):
    """A classified failure; `effect` is None when the caller must assume unknown."""

    def __init__(self, code, effect=None):
        Exception.__init__(self, code)
        self.code = code
        self.effect = effect


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.ReplaceFileW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                  wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
kernel32.ReplaceFileW.restype = wintypes.BOOL
kernel32.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
kernel32.SetFileAttributesW.restype = wintypes.BOOL


def native(path):
    """Canonical `/C:/...` to a native path; very long paths get the extended-length prefix."""
    try:
        result = windows_native(path)
    except InvalidPath:
        raise Failure("INVALID_PATH", "not-applied")
    return "\\\\?\\" + result if len(result) >= LONG_PATH else result


def wire(path):
    try:
        return windows_wire(path)
    except InvalidPath:
        raise Failure("INVALID_PATH", "not-applied")


def attributes(info):
    return getattr(info, "st_file_attributes", 0)


def is_link(info):
    """Symbolic links and junctions are links; other reparse points behave like their content."""
    return bool(attributes(info) & FILE_ATTRIBUTE_REPARSE_POINT) and \
        getattr(info, "st_reparse_tag", 0) in IO_REPARSE_TAGS


def kind_of(info):
    if is_link(info):
        return "symlink"
    return ("directory" if stat.S_ISDIR(info.st_mode) else
            "file" if stat.S_ISREG(info.st_mode) else "other")


def posix_mode(info):
    """Windows reports 0666/0444; group and other write bits are never meaningful here."""
    return stat.S_IMODE(info.st_mode) & ~0o022


def fingerprint(path, data, info):
    identity = (os.path.realpath(path), info.st_dev, info.st_ino, info.st_mode,
                info.st_size, info.st_mtime_ns, attributes(info))
    return hashlib.sha256(json.dumps(identity).encode("utf8") + b"\0" + data).hexdigest()


def read_only(path):
    try:
        return bool(attributes(os.lstat(path)) & FILE_ATTRIBUTE_READONLY)
    except OSError:
        return False


def link_text(path):
    """The link target as text, without the extended-length prefix Windows adds."""
    target = os.readlink(path)
    return target[4:] if target.startswith("\\\\?\\") and not target.startswith("\\\\?\\UNC\\") else target


def error_code(error):
    """Public code for an OSError; sharing violations and read-only files get their own."""
    winerror = getattr(error, "winerror", None)
    if winerror in (ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION):
        return "FILE_IN_USE"
    if winerror == ERROR_ACCESS_DENIED:
        names = [name for name in (error.filename, getattr(error, "filename2", None)) if name]
        if any(read_only(name) for name in names):
            return "FILE_READ_ONLY"
        return "EACCES"
    if winerror == ERROR_PRIVILEGE_NOT_HELD:
        return "SYMLINK_NOT_PERMITTED"
    return None


def set_attributes(path, value):
    if not kernel32.SetFileAttributesW(path, value or FILE_ATTRIBUTE_NORMAL):
        raise ctypes.WinError(ctypes.get_last_error())


def force_unlink(path, info=None):
    """Remove a file, symbolic link or junction itself; read-only files are cleared first."""
    info = info or os.lstat(path)
    if is_link(info) and attributes(info) & FILE_ATTRIBUTE_DIRECTORY:
        os.rmdir(path)
        return
    if attributes(info) & FILE_ATTRIBUTE_READONLY:
        set_attributes(path, attributes(info) & ~FILE_ATTRIBUTE_READONLY)
    os.unlink(path)


def discard(path):
    """Best-effort removal of a staging file."""
    with contextlib.suppress(OSError):
        force_unlink(path)


def remove_tree(path):
    """Delete a directory tree without following links; each level checks the type first."""
    info = os.lstat(path)
    if kind_of(info) != "directory":
        raise Failure("DELETE_TARGET_CHANGED")
    with os.scandir(path) as entries:
        children = [entry.path for entry in entries]
    for child in children:
        child_info = os.lstat(child)
        if kind_of(child_info) == "directory":
            remove_tree(child)
        else:
            force_unlink(child, child_info)
    now = os.lstat(path)
    if kind_of(now) != "directory" or (now.st_dev, now.st_ino) != (info.st_dev, info.st_ino):
        raise Failure("DELETE_TARGET_CHANGED")
    if attributes(now) & FILE_ATTRIBUTE_READONLY:
        set_attributes(path, attributes(now) & ~FILE_ATTRIBUTE_READONLY)
    os.rmdir(path)


def lock_key(path):
    return "dir:" + os.path.normcase(os.path.realpath(path))


def identity_key(info):
    return "file:%s:%s" % (info.st_dev, info.st_ino)


@contextlib.contextmanager
def locked(*keys):
    """Hold a named mutex per key, acquired in sorted order so writers cannot deadlock.

    Global names make the lock visible to every logon session of this machine. A mutex whose
    owner died is abandoned, and the next waiter owns it.
    """
    names = sorted({"Global\\pi-agent-ide-" + hashlib.sha256(key.encode("utf8")).hexdigest()[:40]
                    for key in keys})
    handles = []
    acquired = []
    try:
        for name in names:
            handle = kernel32.CreateMutexW(None, False, name)
            if not handle:
                raise Failure("LOCK_UNAVAILABLE", "not-applied")
            handles.append(handle)
            if kernel32.WaitForSingleObject(handle, LOCK_TIMEOUT_MS) not in (0, 0x80):
                raise Failure("LOCK_TIMEOUT", "not-applied")
            acquired.append(handle)
        yield
    finally:
        for handle in reversed(acquired):
            kernel32.ReleaseMutex(handle)
        for handle in handles:
            kernel32.CloseHandle(handle)


def publish(temporary, destination):
    """Put `temporary` at `destination`, replacing a file there with ReplaceFileW.

    A failure before anything changed is `not-applied`; a half-finished replacement is unknown.
    """
    if not os.path.lexists(destination):
        try:
            os.rename(temporary, destination)
        except FileExistsError:
            raise Failure("CONFLICT", "not-applied")
        except OSError as error:
            raise Failure(error_code(error) or "REMOTE_OPERATION_FAILED", "not-applied")
        return
    if kernel32.ReplaceFileW(destination, temporary, None, 0, None, None):
        return
    winerror = ctypes.get_last_error()
    if winerror in (ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_UNABLE_TO_REMOVE_REPLACED):
        raise Failure("FILE_IN_USE", "not-applied")
    if winerror == ERROR_ACCESS_DENIED:
        raise Failure("FILE_READ_ONLY" if read_only(destination) else "EACCES", "not-applied")
    if winerror in (2, 3):
        raise Failure("CONFLICT", "not-applied")
    if winerror in (ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2):
        raise Failure("REPLACE_FAILED", "unknown")
    raise Failure("REMOTE_OPERATION_FAILED", "unknown")
