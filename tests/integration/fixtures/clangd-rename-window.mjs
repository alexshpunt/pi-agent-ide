import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Message, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

// Relay real clangd requests and inject peer edits at specific points.
const [mode] = process.argv.slice(2);
const clangd = spawn("clangd", [], { stdio: ["pipe", "pipe", "inherit"] });
const toPi = new StreamMessageWriter(process.stdout);
const toClang = new StreamMessageWriter(clangd.stdin);
const waiting = new Set();
const log = (event) => appendFileSync(".tmp/rename-requests", event + "\n");
let requests = 0;
let documentVersion;
const saveConflicts = { "save-first": 1, "save-first-exhaust": 10 }[mode];

new StreamMessageReader(process.stdin).listen((message) => {
  if (
    Message.isNotification(message) &&
    (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange")
  )
    documentVersion = message.params.textDocument.version;
  if (Message.isRequest(message) && message.method === "textDocument/rename") {
    log("rename");
    requests++;
    if (saveConflicts !== undefined) {
      if (requests <= saveConflicts) {
        const { textDocument } = message.params;
        appendFileSync("main.cpp", `int added${requests}() { return normalize(Vec{${requests}}); }\n`);
        // Keep the AST worker busy with the old document while clangd accepts the rename
        // and updates its draft. clangd validates the resulting edits against the new draft.
        void toClang.write({
          jsonrpc: "2.0",
          id: -requests,
          method: "textDocument/documentSymbol",
          params: { textDocument },
        });
        void toClang.write(message);
        void toClang.write({
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: {
            textDocument: { ...textDocument, version: documentVersion },
            contentChanges: [{ text: readFileSync("main.cpp", "utf8") }],
            wantDiagnostics: false,
          },
        });
      } else {
        void toClang.write(message);
      }
      return;
    }
    const writeCount = { stall: 1, replan: 2, exhaust: 10, "auto-repeat": 7, "stall-once": 1 }[mode];
    if (writeCount !== undefined) {
      if (requests <= writeCount)
        appendFileSync("main.cpp", `int added${requests}() { return normalize(Vec{${requests}}); }\n`);
      if ((mode === "stall" && requests > 1) || (mode === "stall-once" && requests === 2)) {
        waiting.add(message.id);
        return;
      }
    } else if (mode === "indent") {
      const source = readFileSync("main.cpp", "utf8");
      writeFileSync(
        "main.cpp",
        "// peer formatted\n" + source.replace(/^ +return normalize\(/gmu, "  $&"),
      );
    } else if (mode === "column") {
      if (requests === 1) {
        const source = readFileSync("main.cpp", "utf8");
        writeFileSync("main.cpp", source.replace("  return ARG;", "    return ARG;"));
      }
    } else if (mode === "lookup" || mode === "binding" || mode === "literal") {
      if (requests === 1) {
        const source = readFileSync("main.cpp", "utf8");
        const changed = mode === "lookup"
          ? source.replace("normalize(argument)", "normalize(scalar)")
          : mode === "binding"
            ? source.replace("Vec{2}", "2")
            : source.replace("// x", "// a longer raw string");
        writeFileSync("main.cpp", changed);
      }
    } else {
      appendFileSync("main.cpp", "// during rename\n");
    }
  }
  if (
    Message.isNotification(message) &&
    message.method === "$/cancelRequest" &&
    waiting.has(message.params?.id)
  ) {
    waiting.delete(message.params.id);
    log("cancel");
    return;
  }
  void toClang.write(message);
});
new StreamMessageReader(clangd.stdout).listen((message) => {
  if (Message.isResponse(message)) {
    if (typeof message.id === "number" && message.id < 0) return;
    if (message.error?.message.startsWith("File must be saved first: ")) log("save-first");
  }
  void toPi.write(message);
});
process.stdin.on("end", () => clangd.stdin.end());
clangd.on("exit", (code) => process.exit(code ?? 1));
