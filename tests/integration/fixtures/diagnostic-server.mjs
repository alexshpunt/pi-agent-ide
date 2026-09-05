// A deterministic stdio LSP server for version, cancellation, and clearing contracts.
const mode = process.argv[2];
let input = Buffer.alloc(0);
const documents = new Map();
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const diagnostics = (text) => text.includes("broken") ? [{
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1, code: "type", message: "A type error, not a syntax error",
}] : [];
function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") send({ id, result: { capabilities: mode === "pull" ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {} } });
  else if (method === "shutdown") { if (mode !== "shutdown-stuck") send({ id, result: null }); }
  else if (method === "exit") process.exit(0);
  else if (method === "textDocument/diagnostic") {
    if (mode.startsWith("pull")) send({ id, result: { kind: "full", items: diagnostics(documents.get(params.textDocument.uri)?.text ?? "") } });
    else send({ id, error: { code: -32601, message: "Pull not supported" } });
  } else if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const { uri, version } = params.textDocument;
    const text = params.textDocument.text ?? params.contentChanges[0].text;
    documents.set(uri, { text, version });
    if (mode !== "pull" && mode !== "silent") {
      const publish = (items, reportVersion = version) => send({ method: "textDocument/publishDiagnostics", params: {
        uri, ...(mode === "unversioned" ? {} : { version: reportVersion }), diagnostics: items,
      } });
      // A stale report must not win the version-aware initial wait.
      publish(diagnostics("broken"), version - 1);
      publish(diagnostics(text));
      if (text.includes("clear-later")) setTimeout(() => publish([]), 40);
    }
  }
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const end = input.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(input.subarray(0, end).toString().match(/Content-Length: (\d+)/iu)?.[1]);
    if (input.length < end + 4 + length) return;
    const message = JSON.parse(input.subarray(end + 4, end + 4 + length).toString());
    input = input.subarray(end + 4 + length);
    handle(message);
  }
});
