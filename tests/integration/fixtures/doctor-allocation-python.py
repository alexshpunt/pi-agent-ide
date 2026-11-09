#!/usr/bin/python3
"""Lose only our fixture's allocation reply after recording the real native receipt."""
import json
import os
import subprocess
import sys
import threading

def read_exact(count):
    data = bytearray()
    while len(data) < count:
        chunk = os.read(0, count - len(data))
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


# The channel starts IDE workers as `python3 -u -c LOADER REQUEST` and sends the
# length-prefixed program on stdin before live input.
args = sys.argv[1:]
workspace = os.environ.get("PI_IDE_OWNED_ALLOCATION_WORKSPACE")
if workspace and len(args) == 4 and args[:2] == ["-u", "-c"]:
    try:
        request = json.loads(args[3])
    except ValueError:
        request = None
    if isinstance(request, dict) and request.get("operation") == "create" and not os.path.exists(os.path.join(workspace, "allow-allocation")):
        prefix = """import builtins, json, os, pathlib
def lose_owned_reply(value, *args, **kwargs):
    data = json.loads(value)
    if isinstance(data, dict) and 'directory' in data:
        data['pid'] = os.getpid()
        pathlib.Path(os.path.join(os.environ['PI_IDE_OWNED_ALLOCATION_WORKSPACE'], 'owned-allocation-receipt.json')).write_text(json.dumps(data), encoding='utf8')
builtins.print = lose_owned_reply
"""
        program = prefix.encode("utf8") + read_exact(int(read_exact(10)))
        child = subprocess.Popen(["/usr/bin/python3", *args], stdin=subprocess.PIPE)

        def pump():
            try:
                child.stdin.write(b"%010d" % len(program) + program)
                child.stdin.flush()
                while chunk := os.read(0, 65536):
                    child.stdin.write(chunk)
                    child.stdin.flush()
                child.stdin.close()
            except (BrokenPipeError, ValueError):
                pass

        # The worker's own exit ends this wrapper, even while its caller keeps stdin open.
        threading.Thread(target=pump, daemon=True).start()
        os._exit(child.wait())
os.execv("/usr/bin/python3", ["/usr/bin/python3", *args])
