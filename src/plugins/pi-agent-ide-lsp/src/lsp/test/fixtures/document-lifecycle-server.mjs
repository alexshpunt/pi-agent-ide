// Push-diagnostics server that records document lifecycle, like clangd.
import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const open = new Map();
const texts = new Map();
const events = [];
const watched = [];
// Like clangd, a delayed analysis publishes nothing when a newer version replaced its text.
const delayMs = Number(process.env.LIFECYCLE_PUBLISH_DELAY_MS ?? 0);
const clearDelayMs = Number(process.env.LIFECYCLE_CLEAR_DELAY_MS ?? 0);
// Like pyright, register pull diagnostics after initialization when the client allows it; its
// pushes are then interim reports without the analysis result, and pulls return complete ones.
const pullDiagnostics = process.env.LIFECYCLE_PULL_DIAGNOSTICS === "1";
let pullRegistered = false;
// Like pyright, ask for new pulls after an analysis and exit when the client refuses.
const refreshAfter = (sent) =>
  void sent.then(() =>
    pullRegistered ? connection.sendRequest("workspace/diagnostic/refresh").catch(() => process.exit(1)) : undefined,
  );
const publish = (uri, version) =>
  pullDiagnostics && version !== undefined
    ? refreshAfter(connection.sendNotification("textDocument/publishDiagnostics", { uri, version, diagnostics: [] }))
    : version !== undefined && delayMs > 0
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

// Like rust-analyzer, report that the project is loading for this long after initialization.
const loadingMs = Number(process.env.LIFECYCLE_LOADING_MS ?? 0);
let serverStatus = false;
// Like rust-analyzer, ask for saves and exit when one arrives while the project loads.
const saveSupport = process.env.LIFECYCLE_SAVE === "1";
const saves = [];
connection.onNotification("textDocument/didSave", ({ textDocument }) => {
  if (loadingMs > 0 && !loaded) {
    process.stderr.write("fixture panic: save during project loading\n");
    process.exit(101);
  }
  saves.push(textDocument.uri);
});
connection.onRequest("lifecycle/saves", () => saves);
connection.onRequest("initialize", ({ capabilities }) => {
  serverStatus = capabilities.experimental?.serverStatusNotification === true;
  pullRegistered = pullDiagnostics && capabilities.textDocument?.diagnostic?.dynamicRegistration === true;
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: 1, ...(saveSupport && { save: true }) },
      documentSymbolProvider: true,
    },
  };
});
const reportStatus = (quiescent) => serverStatus && connection.sendNotification("experimental/serverStatus", { health: "ok", quiescent, message: quiescent ? null : "Loading" });
connection.onNotification("initialized", () => {
  if (pullRegistered)
    void connection.sendRequest("client/registerCapability", {
      registrations: [{ id: "pull-diagnostics", method: "textDocument/diagnostic", registerOptions: { interFileDependencies: true, workspaceDiagnostics: false, documentSelector: null } }],
    });
  if (loadingMs <= 0) return;
  reportStatus(false);
  setTimeout(() => {
    loaded = true;
    reportStatus(true);
  }, loadingMs);
});
let loaded = false;
connection.onRequest("lifecycle/loaded", () => loaded);
connection.onRequest("textDocument/diagnostic", () => ({
  kind: "full",
  items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "fixture error" }],
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
// Answers for the version it had when the request arrived, after LIFECYCLE_RENAME_DELAY_MS.
const renameDelayMs = Number(process.env.LIFECYCLE_RENAME_DELAY_MS ?? 0);
connection.onRequest("textDocument/rename", ({ textDocument }) => {
  const answer = {
    documentChanges: [{ textDocument: { uri: textDocument.uri, version: open.get(textDocument.uri) ?? null }, edits: [] }],
  };
  return renameDelayMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(answer), renameDelayMs)) : answer;
});
connection.onRequest("lifecycle/configuration", async ({ section }) => (await connection.sendRequest("workspace/configuration", { items: [{ section }] }))[0]);
connection.onRequest("lifecycle/watch", ({ pattern }) =>
  connection.sendRequest("client/registerCapability", {
    registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: pattern }] } }],
  }),
);
connection.onNotification("workspace/didChangeWatchedFiles", ({ changes }) => watched.push(...changes));
// Fails the first `failures` attempts for `key` with `code`, like rust-analyzer during edits.
const attempts = new Map();
connection.onRequest("lifecycle/flaky", ({ key, code, failures, data }) => {
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  if (attempt <= failures) throw new ResponseError(code, code === -32801 ? "content modified" : "server cancelled the request", data);
  return attempt;
});
connection.onRequest("lifecycle/slow", ({ ms }) => new Promise((resolve) => setTimeout(() => resolve("slow done"), ms)));
connection.onRequest("lifecycle/crash", () => {
  process.stderr.write("fixture panic: index out of bounds\n");
  process.exit(3);
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
