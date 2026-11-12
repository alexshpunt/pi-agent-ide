"""Framing shared by the POSIX and Windows channel workers."""
import errno
import json
import os
import sys

FRAME_LIMIT = 65536
# Match the bounded startup request; interactive control frames keep their smaller limit.
REQUEST_LIMIT = 48 * 1024 * 1024
CHUNK_SIZE = 16384
# Input frames the host may send before their acknowledgements arrive. The host never queues
# more than 1 MiB per write, which is exactly this many full frames.
INPUT_WINDOW = 64

# Reads a length-prefixed program from stdin, so worker size never meets argv limits.
CHILD_LOADER = (
    "import os\n"
    "def _pi_read(n):\n"
    " b=bytearray()\n"
    " while len(b)<n:\n"
    "  c=os.read(0,n-len(b))\n"
    "  if not c:raise SystemExit(70)\n"
    "  b+=c\n"
    " return bytes(b)\n"
    "exec(compile(_pi_read(int(_pi_read(10))),'<pi-agent-ide>','exec'))\n"
)


class ChannelError(Exception):
    def __init__(self, code):
        self.code = code


def emit(event):
    # Binary stdout keeps frames free of Windows newline translation.
    sys.stdout.buffer.write(json.dumps(event, ensure_ascii=True).encode("ascii") + b"\n")
    sys.stdout.buffer.flush()


def initial_request():
    data = bytearray()
    while len(data) <= REQUEST_LIMIT:
        byte = os.read(0, 1)
        if not byte:
            raise ChannelError("CANCELLED")
        if byte == b"\n":
            return json.loads(data)
        data.extend(byte)
    raise ChannelError("FRAME_LIMIT")


def command_line(request, interpreter):
    """Return argv and the bytes to write to the child's stdin before caller input.

    A `python` request runs an IDE worker with `interpreter`; its source travels on stdin.
    """
    if "python" in request:
        source = request["python"].encode("utf8")
        argv = [interpreter, "-u", "-c", CHILD_LOADER, *request["args"]]
        return argv, b"%010d" % len(source) + source
    return [request["command"], *request["args"]], b""


def error_code(error):
    return errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED")
