#!/usr/bin/python3
"""Hold only a private index-location query so cancellation can inspect its real owned Git child."""
import os
import pathlib
import signal
import sys
import time

if sys.argv[1:] == ["rev-parse", "--git-path", "index"]:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    folder = pathlib.Path.cwd()
    (folder / "git-owned-ready").write_text(str(os.getpid()), encoding="utf-8")
    deadline = time.monotonic() + 30
    while not (folder / "git-owned-release").exists() and time.monotonic() < deadline:
        time.sleep(.02)

os.execv("/usr/bin/git", ["/usr/bin/git", *sys.argv[1:]])
