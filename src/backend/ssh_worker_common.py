"""Request and reply framing shared by the POSIX and Windows file-operation workers."""
import base64
import errno
import json
import sys

MAX_BYTES = 32 * 1024 * 1024


class OperationError(Exception):
    def __init__(self, code):
        self.code = code


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def run(platform):
    """Perform one request read from stdin; `platform.effect` reports partial effects."""
    try:
        request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))
        reply = {"ok": True, "data": platform.perform(request)}
    except OperationError as error:
        reply = {"ok": False, "code": error.code, "effect": platform.effect}
    except OSError as error:
        # A platform can name failures that errno cannot, such as a file open elsewhere.
        classify = getattr(platform, "error_code", None)
        code = (classify and classify(error)) or errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED")
        reply = {"ok": False, "code": code, "effect": platform.effect}
    except Exception:
        reply = {"ok": False, "code": "REMOTE_OPERATION_FAILED", "effect": platform.effect}
    sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=True).encode("ascii") + b"\n")
    sys.stdout.buffer.flush()
