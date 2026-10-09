"""Collect native project names without reading file contents or returning environment values."""
import json
import os
import stat
import subprocess
import sys

ROOT = os.path.abspath(sys.argv[1])
MAX_BYTES = 16 * 1024 * 1024
SKIP = {".git", ".hg", ".svn", "node_modules", "vendor", "build", "dist", "coverage", ".cache", ".next", "target", ".tmp"}


def collect():
    try:
        with subprocess.Popen(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ) as process:
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
        children[:] = [name for name in children if name not in SKIP and not os.path.islink(os.path.join(directory, name))]
        for name in files:
            file = os.path.join(directory, name)
            if stat.S_ISREG(os.lstat(file).st_mode):
                relative = os.path.relpath(file, ROOT)
                if relative.startswith(".pi/pi-agent-ide/"):
                    continue
                size += len(os.fsencode(relative)) + 1
                if size > MAX_BYTES:
                    raise OverflowError()
                names.append(relative)
    return names


try:
    names = [name for name in collect() if not name.startswith(".pi/pi-agent-ide/")]
    print(json.dumps(names))
except OverflowError:
    print(json.dumps({"error": "BYTE_LIMIT"}))
except Exception:
    print(json.dumps({"error": "INVENTORY_FAILED"}))
