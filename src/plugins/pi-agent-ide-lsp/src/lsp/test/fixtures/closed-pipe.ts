import { closeSync, writeFileSync } from "node:fs";
import { URI } from "vscode-uri";
import { LspClient } from "#src/plugins/pi-agent-ide-lsp/src/lsp/client.js";

if (process.argv.includes("--server")) {

  if (process.argv.includes("initialize")) {
    process.stdin.once("data", (chunk: Buffer) => {
      process.stdin.destroy();
      closeSync(0);
      if (process.env.EPIPE_EVIDENCE) writeFileSync(process.env.EPIPE_EVIDENCE, JSON.stringify({ phase: "initialize", receivedBytes: chunk.length }));
    });
  } else {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as { method: string; id?: number };
      buffer = buffer.subarray(end + 4 + length);
      const send = (value: unknown) => {
        const text = JSON.stringify(value);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
      };
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      }
      if (message.method === "initialized") {
        closeSync(0);
        send({ jsonrpc: "2.0", method: "test/closed", params: {} });
      }
    }
  });
  }
  setInterval(() => {}, 1000);
} else {
  const client = new LspClient({
    serverId: "closed-pipe",
    rootUri: URI.file(process.cwd()).toString(),
    command: [process.execPath, process.argv[1]!, "--server", process.argv[2]!],
    initOptions: process.argv[2] === "initialize" ? { payload: "x".repeat(10000000) } : undefined,
  });
  const closed = new Promise<void>((resolve) => client.onNotification("test/closed", () => resolve()));
  try {
    let failureCaught = false;
    try {
      await client.start();
      await closed;
      if (process.argv[2] === "request") {
        await client.sendRequest("test/request", { text: "x".repeat(1000000) });
      } else {
        client.sendNotification("textDocument/didOpen", { text: "x".repeat(1000000) });
      }
    } catch {
      failureCaught = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    let rejected = false;
    try {
      await client.sendRequest("test/after-failure", {});
    } catch {
      rejected = true;
    }
    console.log(JSON.stringify({ survived: true, rejected, failureCaught, ready: client.ready, crashed: client.crashed }));
  } finally {
    await client.shutdown();
  }
}
