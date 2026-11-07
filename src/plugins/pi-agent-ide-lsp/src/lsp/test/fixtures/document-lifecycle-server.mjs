// Push-diagnostics server that records document lifecycle, like clangd.
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const open = new Map();
const events = [];
const publish = (uri, version) =>
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri,
    ...(version === undefined ? {} : { version }),
    diagnostics:
      version === undefined
        ? []
        : [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "fixture error" }],
  });

connection.onRequest("initialize", () => ({
  capabilities: { textDocumentSync: { openClose: true, change: 1 }, documentSymbolProvider: true },
}));
connection.onNotification("textDocument/didOpen", ({ textDocument }) => {
  open.set(textDocument.uri, textDocument.version);
  events.push(["open", textDocument.uri]);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification("textDocument/didChange", ({ textDocument }) => {
  open.set(textDocument.uri, textDocument.version);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification("textDocument/didClose", ({ textDocument }) => {
  open.delete(textDocument.uri);
  events.push(["close", textDocument.uri]);
  // clangd clears diagnostics of a closed document with an unversioned empty report.
  publish(textDocument.uri, undefined);
});
connection.onRequest("textDocument/documentSymbol", () => []);
connection.onRequest("lifecycle/status", () => ({ open: [...open.keys()], events, pid: process.pid }));
connection.onRequest("lifecycle/slow", ({ ms }) => new Promise((resolve) => setTimeout(() => resolve("slow done"), ms)));
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
