import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Message, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const clangd = spawn("clangd", [], { stdio: ["pipe", "pipe", "inherit"] });
const toPi = new StreamMessageWriter(process.stdout);
const toClang = new StreamMessageWriter(clangd.stdin);
const outlines = new Set();
let omitted = false;

new StreamMessageReader(process.stdin).listen((message) => {
  if (Message.isRequest(message) && message.method === "textDocument/documentSymbol")
    outlines.add(message.id);
  void toClang.write(message);
});
new StreamMessageReader(clangd.stdout).listen((message) => {
  if (Message.isResponse(message) && outlines.delete(message.id) && Array.isArray(message.result)) {
    const other = message.result.filter(
      (symbol) => symbol.name !== "normalize" || !symbol.detail?.includes("Vec"),
    );
    if (!omitted && other.length < message.result.length) {
      omitted = true;
      // Keep the int overload, but omit the Vec overload while a peer changes unrelated text.
      appendFileSync("main.cpp", "// peer write\n");
      message = { ...message, result: other };
    }
  }
  void toPi.write(message);
});
process.stdin.on("end", () => clangd.stdin.end());
clangd.on("exit", (code) => process.exit(code ?? 1));
