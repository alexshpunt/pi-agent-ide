#!/usr/bin/python3
"""Fixture ripgrep: emit one path and then keep the walker busy past the tool deadline."""

from pathlib import Path
import os
import sys
import time

if sys.argv[1:] == ["--version"]:
    print("ripgrep 14.1.0")
    sys.exit(0)
if "--files" not in sys.argv[1:]:
    sys.exit(2)

root = Path(sys.argv[-1])
stat = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
_ = (root / "walker.pid").write_text(f"{os.getpid()} {stat[19]} {time.time_ns() // 1_000_000}\n")
print(root / "first.fixture", flush=True)
# Bound the fixture even if the tool fails to cancel it.
time.sleep(45)
print(root / "late.fixture", flush=True)
