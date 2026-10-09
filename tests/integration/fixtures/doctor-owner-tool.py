#!/usr/bin/python3
"""Native formatter/linter fixture that records its own PID and edits only its private probe."""
import json
import os
from pathlib import Path
import sys

mode, source = sys.argv[1:]
probe = Path(source)
if not probe.parent.name.startswith(".pi-agent-ide-doctor-") or probe.parent.parent.name != ".tmp":
    raise SystemExit(7)
marker = Path(os.environ["PI_IDE_DOCTOR_MARKER"] + "-" + mode)
pids = json.loads(marker.read_text()) if marker.exists() else []
pids.append(os.getpid())
marker.write_text(json.dumps(pids))
if mode == "format":
    probe.write_text(probe.read_text().replace("42", "43"))
elif mode == "lint":
    print("[]")
else:
    raise SystemExit(7)
