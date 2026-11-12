"""Request and reply framing shared by the POSIX and Windows file-operation workers."""
import base64
import errno
import hashlib
import json
import struct
import sys

MAX_BYTES = 32 * 1024 * 1024
STREAM_CHUNK = 1024 * 1024


class OperationError(Exception):
    def __init__(self, code):
        self.code = code


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def stream(platform, request, output, started):
    """Send a byte window of a regular file, then return the SHA-256 of the sent bytes.

    An optional `revision` must match the opened file. `offset` counts from the end when
    negative and clamps to the file; `limit` caps the window, which otherwise runs to the end.
    After a header line with the file size, revision and the window's offset and length, bytes
    follow as chunks that each start with a 4-byte big-endian length. A zero length ends them,
    also after a failure, and the usual reply line follows. `started` runs once the header is
    sent. The file must keep its revision until the last byte is sent.
    """
    with platform.stream_source(request["path"]) as (size, revision, read, seek, current):
        expected = request.get("revision")
        if expected is not None and revision != expected:
            raise OperationError("CONFLICT")
        offset = request.get("offset", 0)
        limit = request.get("limit")
        start = min(size, max(0, size + offset if offset < 0 else offset))
        length = size - start if limit is None else min(limit, size - start)
        seek(start)
        header = {"size": size, "revision": revision, "offset": start, "length": length}
        output.write(json.dumps(header).encode("ascii") + b"\n")
        started()
        digest = hashlib.sha256()
        remaining = length
        while remaining:
            chunk = read(min(STREAM_CHUNK, remaining))
            if not chunk:
                raise OperationError("CONFLICT")
            output.write(struct.pack(">I", len(chunk)) + chunk)
            digest.update(chunk)
            remaining -= len(chunk)
        if current() != revision:
            raise OperationError("CONFLICT")
    return {"sha256": digest.hexdigest()}


def run(platform):
    """Perform one request read from stdin; `platform.effect` reports partial effects."""
    output = sys.stdout.buffer
    streaming = False

    def started():
        nonlocal streaming
        streaming = True

    try:
        request = json.loads(sys.stdin.buffer.read(MAX_BYTES * 2))
        if request.get("operation") == "stream":
            data = stream(platform, request, output, started)
        else:
            data = platform.perform(request)
        reply = {"ok": True, "data": data}
    except OperationError as error:
        reply = {"ok": False, "code": error.code, "effect": platform.effect}
    except OSError as error:
        # A platform can name failures that errno cannot, such as a file open elsewhere.
        classify = getattr(platform, "error_code", None)
        code = (classify and classify(error)) or errno.errorcode.get(error.errno, "REMOTE_OPERATION_FAILED")
        reply = {"ok": False, "code": code, "effect": platform.effect}
    except Exception:
        reply = {"ok": False, "code": "REMOTE_OPERATION_FAILED", "effect": platform.effect}
    if streaming:
        output.write(struct.pack(">I", 0))
    output.write(json.dumps(reply, ensure_ascii=True).encode("ascii") + b"\n")
    output.flush()
