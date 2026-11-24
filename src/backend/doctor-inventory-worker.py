"""Collect native project names without reading file contents or returning environment values."""
import json
import os
import stat
import subprocess

WINDOWS = os.name == "nt"

ROOT = os.getcwd()
MAX_BYTES = 16 * 1024 * 1024
SKIP = {".git", ".hg", ".svn", "node_modules", "vendor", "build", "dist", "coverage", ".cache", ".next", "target", ".tmp"}


def reparse(info):
    return WINDOWS and bool(info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def include_directory(directory, name):
    if (name.lower() if WINDOWS else name) in SKIP:
        return False
    info = os.lstat(directory)
    return stat.S_ISDIR(info.st_mode) and not reparse(info)


def collect():
    try:
        with subprocess.Popen(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ) as process:
            assert process.stdout is not None
            output = process.stdout.read(MAX_BYTES + 1)
            if len(output) > MAX_BYTES:
                process.kill()
                process.wait()
                raise OverflowError()
            if process.wait(timeout=10) != 0:
                raise subprocess.SubprocessError()
        names = [os.fsdecode(name) for name in output.split(b"\0") if name]
        if names:
            return names
    except (OSError, subprocess.SubprocessError):
        pass
    names = []
    size = 0
    for directory, children, files in os.walk(ROOT, followlinks=False):
        children[:] = [name for name in children if include_directory(os.path.join(directory, name), name)]
        for name in files:
            file = os.path.join(directory, name)
            info = os.lstat(file)
            if stat.S_ISREG(info.st_mode) and not reparse(info):
                relative = os.path.relpath(file, ROOT)
                size += len(os.fsencode(relative)) + 1
                if size > MAX_BYTES:
                    raise OverflowError()
                names.append(relative)
    return names


try:
    names = (name.replace("\\", "/") if WINDOWS else name for name in collect())
    print(json.dumps([name for name in names if not (name.lower() if WINDOWS else name).startswith(".pi/pi-agent-ide/")]))
except OverflowError:
    print(json.dumps({"error": "BYTE_LIMIT"}))
except Exception:
    print(json.dumps({"error": "INVENTORY_FAILED"}))
