"""Read one HTTP(S) URL using only the target account's network environment."""
import base64
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BODY = 16 * 1024 * 1024
BINARY_PREVIEW = 4096


class Refused(Exception):
    pass


def read_response(request):
    url = urllib.parse.urldefrag(request["url"])[0]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise Refused("INVALID_SOURCE")
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Pi-LPT/1.0; +https://github.com/alexshpunt/sasha-pi)",
        "Accept": "text/html,application/xhtml+xml,application/pdf,application/json,text/plain,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, headers=headers, method="GET"), timeout=request["timeoutSeconds"])
    except urllib.error.HTTPError as error:
        response = error
    with response:
        media_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        supported = (not media_type or media_type.startswith(("text/", "image/"))
            or media_type in ("application/json", "application/xml", "application/xhtml+xml", "application/pdf")
            or media_type.endswith(("+json", "+xml")))
        document = re.search(r"\.(?:avif|bmp|gif|jpe?g|pdf|png|webp)$", parsed.path, re.I)
        limit = MAX_BODY if supported or document else BINARY_PREVIEW
        body = response.read(limit + (1 if limit == MAX_BODY else 0))
        if len(body) > MAX_BODY:
            raise Refused("BYTE_LIMIT")
        return {
            "url": response.geturl(),
            "status": response.status,
            "statusText": str(response.reason),
            "headers": list(response.headers.items()),
            "body": base64.b64encode(body).decode("ascii"),
        }


try:
    print(json.dumps(read_response(json.loads(sys.argv[1]))))
except Refused as error:
    print(json.dumps({"error": str(error)}))
except (TimeoutError, socket.timeout):
    print(json.dumps({"error": "TIMEOUT"}))
except urllib.error.URLError as error:
    print(json.dumps({"error": "TIMEOUT" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "HTTP_FAILED"}))
except Exception:
    # Never return proxy credentials, authorization paths or native transport diagnostics.
    print(json.dumps({"error": "HTTP_FAILED"}))
