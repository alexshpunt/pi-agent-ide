#!/usr/bin/python3
"""Lose only our fixture's allocation reply after recording the real native receipt."""
import json
import os
import sys

args = sys.argv[1:]
workspace = os.environ.get("PI_IDE_OWNED_ALLOCATION_WORKSPACE")
if workspace and len(args) == 3 and args[0] == "-c":
    try:
        request = json.loads(args[2])
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
        args[1] = prefix + args[1]
os.execv("/usr/bin/python3", ["/usr/bin/python3", *args])
