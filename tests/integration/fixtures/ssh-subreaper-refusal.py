#!/usr/bin/python3
"""Refuse only the native channel's subreaper facility in a private SSH fixture."""
import os
import sys

args = sys.argv[1:]
mode = os.environ.get("PI_IDE_SUBREAPER_REFUSAL")
if len(args) == 2 and args[0] == "-c" and mode in ("missing", "denied"):
    if mode == "missing":
        prefix = """import builtins
_original_import = builtins.__import__
def without_ctypes(name, *args, **kwargs):
    if name == 'ctypes':
        raise ImportError('Fixture has no ctypes')
    return _original_import(name, *args, **kwargs)
builtins.__import__ = without_ctypes
"""
    else:
        prefix = """import ctypes, errno
_original_library = ctypes.CDLL
class RefusedPrctl:
    def __call__(self, *args):
        ctypes.set_errno(errno.EPERM)
        return -1
class RefusedSubreaperLibrary:
    def __init__(self, *args, **kwargs):
        self.library = _original_library(*args, **kwargs)
    def __getattr__(self, name):
        return RefusedPrctl() if name == 'prctl' else getattr(self.library, name)
ctypes.CDLL = RefusedSubreaperLibrary
"""
    args[1] = prefix + args[1]
os.execv("/usr/bin/python3", ["/usr/bin/python3", *args])
