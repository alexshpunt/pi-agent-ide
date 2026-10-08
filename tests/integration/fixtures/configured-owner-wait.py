import os
import pathlib
import sys
import time

source, marker, release = map(pathlib.Path, sys.argv[1:])
source.write_text('label = "café after command"\n', encoding="utf-8")
print("Owned stdout café", flush=True)
print("Owned stderr café", file=sys.stderr, flush=True)
marker.write_text(str(os.getpid()), encoding="utf-8")
deadline = time.monotonic() + 30
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.05)
