"""Resolve a target debugger runtime and its required files, without starting the adapter."""
import json
import os
import shutil
import subprocess
import sys


def choose(request):
    windows = os.name == "nt"
    prefixes = request["prefixes"]
    environment = dict(os.environ)
    environment["PATH"] = os.pathsep.join(prefixes + [environment.get("PATH", os.defpath)])
    if windows:
        from ssh_windows_commands import find_executable

        def resolve(command):
            return find_executable(command, os.getcwd(), environment)
    else:
        def resolve(command):
            return shutil.which(command, path=environment["PATH"])
    override = next((os.environ[key] for key in request.get("overrides", ()) if os.environ.get(key)), None)
    if request.get("python") and override is None:
        python = "python.exe" if windows else "python3"
        command = next((resolve(os.path.join(prefix, python)) for prefix in prefixes[1:3]
                        if os.path.isfile(os.path.join(prefix, python))), sys.executable)
    else:
        command = resolve(override or request["command"])
    files = [*request.get("files", ()),
             *(os.environ.get(key, default) for key, default in request.get("fileOverrides", ()))]
    if command is None or any(not os.path.isfile(file) for file in files):
        return None
    if request.get("python"):
        try:
            reply = subprocess.run(
                [command, "-c", "import importlib.util; raise SystemExit(importlib.util.find_spec('debugpy') is None)"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=8,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if reply.returncode != 0:
            return None
    return {"command": command, "files": files}


receipt = choose(json.loads(sys.argv[1]))
if receipt is None:
    sys.exit(3)
print(json.dumps(receipt, ensure_ascii=True))
