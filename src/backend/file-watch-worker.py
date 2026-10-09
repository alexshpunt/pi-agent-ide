"""Native Linux file notifications for one transient SSH subscription."""
import ctypes
import errno
import json
import os
import select
import struct
import sys


def send(value):
    print(json.dumps(value), flush=True)


def run():
    roots = json.loads(sys.argv[1])
    library = ctypes.CDLL(None, use_errno=True)
    initialize = library.inotify_init1
    initialize.argtypes = [ctypes.c_int]
    initialize.restype = ctypes.c_int
    add = library.inotify_add_watch
    add.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    add.restype = ctypes.c_int
    descriptor = initialize(os.O_NONBLOCK | os.O_CLOEXEC)
    if descriptor < 0:
        raise OSError(ctypes.get_errno(), "WATCH_START_FAILED")
    directories = {}
    subscribed = set()
    existing = set()
    mask = 0x2 | 0x4 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000000

    def changed(source, kind):
        if kind == 3:
            if source not in existing:
                return
            existing.remove(source)
        else:
            kind = 2 if source in existing else 1
            existing.add(source)
        send({"kind": "change", "path": source, "type": kind})

    def subscribe_tree(root, notify=False):
        if not os.path.isdir(root):
            raise FileNotFoundError(root)
        for directory, children, files in os.walk(root):
            if directory not in subscribed:
                watch = add(descriptor, os.fsencode(directory), mask)
                if watch < 0:
                    raise OSError(ctypes.get_errno(), "WATCH_START_FAILED")
                directories[watch] = directory
                subscribed.add(directory)
            for source in [directory] + [os.path.join(directory, name) for name in children + files]:
                if source not in existing:
                    if notify:
                        changed(source, 1)
                    else:
                        existing.add(source)

    try:
        for root in roots:
            subscribe_tree(root)
        send({"kind": "ready"})
        while True:
            select.select([descriptor], [], [])
            try:
                events = os.read(descriptor, 65536)
            except BlockingIOError:
                continue
            offset = 0
            while offset < len(events):
                watch, flags, _cookie, length = struct.unpack_from("iIII", events, offset)
                offset += 16
                name = os.fsdecode(events[offset:offset + length].split(b"\0", 1)[0])
                offset += length
                if flags & 0x4000:
                    raise RuntimeError("WATCH_OVERFLOW")
                directory = directories.get(watch)
                if directory is None:
                    continue
                if flags & 0x8000:
                    directories.pop(watch, None)
                    subscribed.discard(directory)
                    continue
                source = os.path.join(directory, name) if name else directory
                if not name and flags & (0x400 | 0x800) and directory in roots:
                    raise RuntimeError("WATCH_ROOT_REMOVED")
                if flags & (0x40 | 0x200 | 0x400):
                    if flags & 0x40000000:
                        prefix = source + os.sep
                        for child in sorted(existing.copy()):
                            if child.startswith(prefix):
                                changed(child, 3)
                        for child_watch, child_directory in list(directories.items()):
                            if child_directory == source or child_directory.startswith(prefix):
                                directories.pop(child_watch, None)
                                subscribed.discard(child_directory)
                                library.inotify_rm_watch(descriptor, child_watch)
                    changed(source, 3)
                elif flags & (0x80 | 0x100):
                    changed(source, 1)
                    if flags & 0x40000000:
                        try:
                            subscribe_tree(source, notify=True)
                        except FileNotFoundError:
                            pass  # A newly created directory can disappear before subscription.
                elif flags & (0x2 | 0x4 | 0x8):
                    changed(source, 2)
    finally:
        os.close(descriptor)


try:
    run()
except (AttributeError, OSError, RuntimeError) as error:
    code = "WATCH_OVERFLOW" if str(error) == "WATCH_OVERFLOW" else "WATCH_FAILED"
    if isinstance(error, OSError) and error.errno == errno.ENOSPC:
        code = "WATCH_LIMIT"
    send({"kind": "error", "code": code})
    sys.exit(1)
