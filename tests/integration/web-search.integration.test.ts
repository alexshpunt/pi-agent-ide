import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  getSystemPrompt,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

test("real Pi searches converted web pages without a prior Read", async () => {
  const root = path.resolve(".tmp/web-search-runtime");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "run-"));
  const server = createServer((request, response) => {
    if (request.url === "/short") {
      response.writeHead(302, { Location: "/guide?redirected=1" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      "<html><head><title>Extensions guide</title></head><body><article><h1>Extensions</h1><p>Extensions add tools to your agent.</p><p>Install extensions to customize your workspace.</p></article></body></html>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server");
  const url = `http://127.0.0.1:${address.port}/short`;
  try {
    const result = await new PiIntegrationTest({
      testName: "web-url-search",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["search"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "web-search",
              name: "search",
              arguments: { query: "extensions", path: url, limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "web-regex",
              name: "search",
              arguments: { query: "regex:Extensions?", path: url, limit: 2 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Search this web page for extensions without reading it first.");
    expect(getToolExecution(result, "web-search").isError).toBe(false);
    const output = getToolResultText(result, "web-search");
    expect(output).toContain(url);
    expect(output).toContain("limit reached");
    expect(output).not.toContain("<html>");
    expect(output).not.toContain("No such file");
    expect(output).not.toContain("redirected=1");
    expect(result.tuiRenderedOutput).toContain(url);
    expect(result.tuiRenderedOutput).toContain("Extensions");
    expect(result.tuiRenderedOutput).toContain("limit reached");
    expect(getSystemPrompt(result)).toContain("no prior read is required");
    expect(getToolExecution(result, "web-regex").isError).toBe(false);
    const regexOutput = getToolResultText(result, "web-regex");
    expect(regexOutput).toContain(url);
    expect(regexOutput).toContain("Extensions");
    expect(regexOutput).not.toContain("No such file");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
