// Push-diagnostics server that records document lifecycle, like clangd.
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const open = new Map();
const texts = new Map();
const events = [];
const watched = [];
// Like clangd, a delayed analysis publishes nothing when a newer version replaced its text.
const delayMs = Number(process.env.LIFECYCLE_PUBLISH_DELAY_MS ?? 0);
const clearDelayMs = Number(process.env.LIFECYCLE_CLEAR_DELAY_MS ?? 0);
const publish = (uri, version) =>
  version !== undefined && delayMs > 0
    ? setTimeout(() => open.get(uri) === version && send(uri, version), delayMs)
    : send(uri, version);
const send = (uri, version) =>
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
  texts.set(textDocument.uri, textDocument.text);
  events.push(["open", textDocument.uri]);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) => {
  open.set(textDocument.uri, textDocument.version);
  texts.set(textDocument.uri, contentChanges.at(-1).text);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification("textDocument/didClose", ({ textDocument }) => {
  open.delete(textDocument.uri);
  texts.delete(textDocument.uri);
  events.push(["close", textDocument.uri]);
  // clangd clears diagnostics of a closed document with an unversioned empty report; a busy
  // server can send it late.
  if (clearDelayMs > 0) setTimeout(() => send(textDocument.uri, undefined), clearDelayMs);
  else publish(textDocument.uri, undefined);
});
connection.onRequest("textDocument/documentSymbol", () => []);
connection.onRequest("lifecycle/status", () => ({ open: [...open.keys()], events, watched, pid: process.pid }));
connection.onRequest("lifecycle/text", ({ textDocument }) => texts.get(textDocument.uri) ?? null);
connection.onRequest("textDocument/rename", ({ textDocument }) => ({
  documentChanges: [{ textDocument: { uri: textDocument.uri, version: open.get(textDocument.uri) ?? null }, edits: [] }],
}));
connection.onRequest("lifecycle/configuration", async ({ section }) => (await connection.sendRequest("workspace/configuration", { items: [{ section }] }))[0]);
connection.onRequest("lifecycle/watch", ({ pattern }) =>
  connection.sendRequest("client/registerCapability", {
    registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: pattern }] } }],
  }),
);
connection.onNotification("workspace/didChangeWatchedFiles", ({ changes }) => watched.push(...changes));
connection.onRequest("lifecycle/slow", ({ ms }) => new Promise((resolve) => setTimeout(() => resolve("slow done"), ms)));
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
