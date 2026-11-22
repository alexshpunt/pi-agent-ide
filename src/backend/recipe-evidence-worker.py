"""Read only requested native project evidence; never execute project files."""
import json
import os
import sys

root, request = sys.argv[1], json.loads(sys.argv[2])
if os.name == "nt" and root[:1] == "/" and root[2:3] == ":":
    root = root[1:]  # The host names Windows paths /C:/...; Windows APIs need C:/...
content = {}
for name in request["files"]:
    try:
        with open(os.path.join(root, name), "rb") as source:
            data = source.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            print(json.dumps({"error": "CONTENT_LIMIT"}))
            sys.exit(0)
        content[name] = data.decode("utf8", errors="replace")
    except FileNotFoundError:
        content[name] = None
markers = {}
for name in request["markers"]:
    try:
        os.stat(os.path.join(root, name))
        markers[name] = True
    except FileNotFoundError:
        markers[name] = False
names = os.listdir(root) if request["listNames"] else []
print(json.dumps({"content": content, "markers": markers, "names": names}))
