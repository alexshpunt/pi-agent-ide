"""Hand off private probes only after a receipt, with native directory identity checks."""
import errno
import json
import os
import select
import signal
import stat
import sys
import tempfile

request = json.loads(sys.argv[1])


def matches(info, device, inode):
    return str(info.st_dev) == device and str(info.st_ino) == inode


def remove_container(data):
    container = data["container"]
    if os.path.basename(container) != ".tmp":
        raise ValueError()
    parent_fd = os.open(os.path.dirname(container), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.stat(".tmp", dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or not matches(info, data["device"], data["inode"]):
            raise ValueError()
        try:
            os.rmdir(".tmp", dir_fd=parent_fd)
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                raise
            # New unrelated contents are not ours to remove.
    finally:
        os.close(parent_fd)


def remove_probe(data):
    directory = data["directory"]
    name = os.path.basename(directory)
    container = os.path.dirname(directory)
    if not name.startswith(".pi-agent-ide-doctor-") or os.path.basename(container) != ".tmp":
        raise ValueError()
    parent_fd = os.open(container, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if not matches(os.fstat(parent_fd), data["containerDevice"], data["containerInode"]):
            raise ValueError()
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            if not matches(os.fstat(fd), data["device"], data["inode"]):
                raise ValueError()
            entries = os.listdir(fd)
            probe = data["name"]
            if probe in ("", ".", "..") or os.path.basename(probe) != probe or any(entry != probe for entry in entries):
                raise ValueError()
            if entries:
                if not stat.S_ISREG(os.stat(probe, dir_fd=fd, follow_symlinks=False).st_mode):
                    raise ValueError()
                os.unlink(probe, dir_fd=fd)
            if not matches(os.stat(name, dir_fd=parent_fd, follow_symlinks=False), data["device"], data["inode"]):
                raise ValueError()
            os.rmdir(name, dir_fd=parent_fd)
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)


def interrupted(_signal, _frame):
    raise InterruptedError()


def create_probe():
    container = os.path.join(os.path.dirname(request["source"]), ".tmp")
    created = False
    receipt = None
    container_identity = None
    entry_name = None
    retained = False
    signal.signal(signal.SIGTERM, interrupted)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    try:
        try:
            os.mkdir(container, 0o700)
            created = True
            container_identity = os.stat(container, follow_symlinks=False)
        except FileExistsError:
            pass
        container_fd = os.open(container, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            container_info = os.fstat(container_fd)
            if created and not matches(container_info, str(container_identity.st_dev), str(container_identity.st_ino)):
                raise ValueError()
            entry = tempfile.mkdtemp(prefix=".pi-agent-ide-doctor-", dir=f"/proc/self/fd/{container_fd}")
            name = os.path.basename(entry)
            entry_name = name
            info = os.stat(name, dir_fd=container_fd, follow_symlinks=False)
            receipt = {"directory": os.path.join(container, name), "device": str(info.st_dev), "inode": str(info.st_ino), "containerCreated": created, "containerDevice": str(container_info.st_dev), "containerInode": str(container_info.st_ino)}
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            print(json.dumps(receipt), flush=True)
            # An absent reply, EOF or stopped channel cannot transfer cleanup ownership.
            if select.select([sys.stdin], [], [], 5)[0] and sys.stdin.readline(32) == "retain\n":
                retained = True
            else:
                raise ValueError()
        finally:
            os.close(container_fd)
    finally:
        # Further TERM requests must not interrupt our exact-entry rollback.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        if not retained:
            try:
                if receipt is not None:
                    remove_probe({**receipt, "name": os.path.basename(request["source"])})
                elif entry_name is not None:
                    # Allocation without a recorded entry identity is not safe to remove.
                    raise ValueError()
                if created and container_identity is not None:
                    remove_container({"container": container, "device": str(container_identity.st_dev), "inode": str(container_identity.st_ino)})
            except Exception:
                print(json.dumps({"error": "PROBE_CLEANUP_FAILED"}), flush=True)
                sys.exit(2)


try:
    operation = request["operation"]
    if operation == "create":
        create_probe()
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
    if request["operation"] == "create":
        sys.exit(1)
