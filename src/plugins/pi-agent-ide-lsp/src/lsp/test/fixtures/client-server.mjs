import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let configuration;
let registered = false;
const changes = [];

const saves = [];
connection.onNotification("textDocument/didSave", (params) => saves.push(params));
let initializeFolders;
let requestedFolders;
connection.onRequest("initialize", (params) => {
  initializeFolders = params.workspaceFolders;
  return { capabilities: { textDocumentSync: { openClose: true, change: 1, save: { includeText: true } } } };
});
connection.onNotification("initialized", async () => {
  configuration = await connection.sendRequest("workspace/configuration", { items: [{ section: "matrix.enabled" }, { section: "missing" }] });
  await connection.sendRequest("client/registerCapability", { registrations: [{ id: "matrix", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: "**/*.matrix" }] } }] });
  await connection.sendRequest("window/workDoneProgress/create", { token: "matrix" });
  requestedFolders = await connection.sendRequest("workspace/workspaceFolders");

  await connection.sendRequest("client/registerCapability", { registrations: [{ id: "configuration", method: "workspace/didChangeConfiguration" }] });
  registered = true;
});
connection.onNotification("workspace/didChangeWatchedFiles", (params) => changes.push(...params.changes));

connection.onNotification("textDocument/didOpen", (params) => connection.sendNotification("textDocument/publishDiagnostics", { uri: params.textDocument.uri, version: params.textDocument.version, diagnostics: [] }));
connection.onRequest("matrix/status", () => ({ registered, configuration, changes, initializeFolders, requestedFolders, saves }));
connection.onRequest("matrix/unregister", async () => {
  await connection.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "matrix", method: "workspace/didChangeWatchedFiles" }] });
  return null;
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
