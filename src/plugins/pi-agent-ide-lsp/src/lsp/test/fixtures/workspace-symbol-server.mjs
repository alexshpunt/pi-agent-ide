import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const provider = process.argv[2] === "absent" ? undefined : JSON.parse(process.argv[2]);
connection.onRequest("initialize", () => ({ capabilities: { workspaceSymbolProvider: provider } }));
if (provider === true || (typeof provider === "object" && provider !== null)) {
  connection.onRequest("workspace/symbol", () => {
    if (process.argv[3] === "fail") throw new Error("eligible workspace request failed");
    return [];
  });
}
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
