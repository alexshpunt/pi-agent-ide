#!/usr/bin/env python3
"""A deliberately different listener PID must not receive the selected adapter's DAP input."""
import os
import signal
import subprocess
import sys

child = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "owned-tcp-peer"), *sys.argv[1:]])


def stop(_signum, _frame):
    if child.poll() is None:
        child.terminate()
    child.wait()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    child.wait()
finally:
    if child.poll() is None:
        child.terminate()
        child.wait()
