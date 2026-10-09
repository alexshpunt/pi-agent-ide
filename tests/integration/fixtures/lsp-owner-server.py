#!/usr/bin/python3
"""Small real stdio language server for owner and lifecycle contracts."""
import json
import os
import sys
import time
from urllib.parse import urlparse, unquote

rename_counts = {}

state = {}


def send(message):
    body = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()


while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    if length is None:
        raise RuntimeError("Missing content length")
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get("method")
    params = message.get("params", {})
    result = None
    if method == "initialize":
        marker = params.get("initializationOptions", {}).get("ownerInitializeMarker")
        if marker:
            with open(marker, "w", encoding="utf-8") as ready:
                ready.write(str(os.getpid()))
        time.sleep(params.get("initializationOptions", {}).get("ownerInitializeDelay", 0))
        state = {"receivedRoot": params["rootUri"], "clientPid": params["processId"], "serverPid": os.getpid(), "environment": os.getenv("LSP_OWNER_TEST"), "watching": params["capabilities"]["workspace"]["didChangeWatchedFiles"]}
        state["watchRequested"] = params.get("initializationOptions", {}).get("ownerWatchTest", False)
        state["ignoreExit"] = params.get("initializationOptions", {}).get("ownerIgnoreExit", False)
        state["exitOnSymbolQuery"] = params.get("initializationOptions", {}).get("ownerExitOnSymbolQuery")
        state["watchRegistered"] = False
        state["watchChanges"] = []
        result = {"capabilities": {"textDocumentSync": 1, "renameProvider": True, "workspaceSymbolProvider": True, "documentSymbolProvider": True, "referencesProvider": True}}
    elif method == "initialized" and state.get("watchRequested"):
        send({"jsonrpc": "2.0", "id": 777, "method": "client/registerCapability", "params": {"registrations": [{"id": "owned-watch", "method": "workspace/didChangeWatchedFiles", "registerOptions": {"watchers": [{"globPattern": {"baseUri": state["receivedRoot"], "pattern": "**/*.ts"}, "kind": 7}]}}]}})
    elif method is None and message.get("id") == 777:
        state["watchRegistered"] = "error" not in message
        state["watchError"] = message.get("error")
    elif method is None and message.get("id") == 778:
        state["watchUnregistered"] = "error" not in message
    elif method == "workspace/didChangeWatchedFiles":
        state["watchChanges"].extend(params["changes"])
        for uri, version in state.get("openDocuments", {}).items():
            summary = "; ".join(str(change["type"]) + " " + change["uri"] for change in params["changes"])
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": uri, "version": version, "diagnostics": [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}, "severity": 2, "message": "Owned watcher events: " + summary}]}})
    elif method == "matrix/unregisterWatch":
        send({"jsonrpc": "2.0", "id": 778, "method": "client/unregisterCapability", "params": {"unregisterations": [{"id": "owned-watch", "method": "workspace/didChangeWatchedFiles"}]}})
    elif method == "textDocument/documentSymbol":
        result = [{"name": "label", "kind": 14, "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 21}}, "selectionRange": {"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}}]
    elif method == "workspace/symbol":
        if params["query"] == state.get("exitOnSymbolQuery"):
            os._exit(7)
        if params["query"] == "unsupported":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "workspace/symbol is unavailable"}})
            continue
        if params["query"] == "broken":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": "Owned navigation failure"}})
            continue
        result = [{"name": "label", "kind": 14, "location": {"uri": state["receivedRoot"] + "/note.ts", "range": {"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}}}] if params["query"] == "label" else []
    elif method == "textDocument/references":
        result = [{"uri": state["receivedRoot"] + "/" + name, "range": {"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}} for name in ("note.ts", "reference.ts") if os.path.isfile(unquote(urlparse(state["receivedRoot"] + "/" + name).path))]
    elif method == "textDocument/prepareCallHierarchy":
        result = [{"name": "label", "kind": 14, "uri": params["textDocument"]["uri"], "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 21}}, "selectionRange": {"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}}]
    elif method in ("callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"):
        item = dict(params["item"], uri=state["receivedRoot"] + "/reference.ts")
        result = [{"from" if method.endswith("incomingCalls") else "to": item, "fromRanges": [{"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}]}]
    elif method == "textDocument/rename":
        uri = params["textDocument"]["uri"]
        change = {"range": {"start": {"line": 0, "character": 6}, "end": {"line": 0, "character": 11}}, "newText": params["newName"]}
        result = {"changes": {uri: [change]}}
        reference_uri = uri.rsplit("/", 1)[0] + "/reference.ts"
        reference_path = unquote(urlparse(reference_uri).path)
        if os.path.isfile(reference_path):
            result["changes"][reference_uri] = [change]
        name = params["newName"]
        rename_counts[name] = rename_counts.get(name, 0) + 1
        if name == "raced" and rename_counts[name] == 2:
            with open(reference_path, "w", encoding="utf-8") as reference:
                reference.write('const external = "keep";\n')
    elif method == "matrix/hold":
        with open(params["marker"], "w", encoding="utf-8") as ready:
            ready.write(str(os.getpid()))
        # Keep this one request pending while still serving shutdown or other requests.
        continue
    elif method == "matrix/status":
        result = state
    elif method == "matrix/echo":
        result = {"uri": params["textDocument"]["uri"], "receivedUri": params["textDocument"]["uri"], "text": params["text"]}
    elif method == "matrix/edit":
        result = {"changes": {params["textDocument"]["uri"]: [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}, "newText": "file:///literal/source/text"}]}}
    elif method == "textDocument/didOpen":
        document = params["textDocument"]
        state.setdefault("openDocuments", {})[document["uri"]] = document["version"]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": document["uri"], "version": document["version"], "diagnostics": [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}, "severity": 2, "message": "Owned diagnostic snapshot"}]}})
    elif method == "exit" and not state.get("ignoreExit", False):
        sys.exit(0)
    if "id" in message and method is not None:
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})
