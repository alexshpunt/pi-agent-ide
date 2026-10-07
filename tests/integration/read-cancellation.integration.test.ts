import { createServer } from "node:http";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("a cancelled HTTP Read reports no completed result and a fresh Read still works", async () => {
  let slowRequests = 0;
  let interrupted = false;
  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      slowRequests += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("unfinished source bytes\n");
      response.on("close", () => {
        interrupted = !response.writableEnded;
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("complete source\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server port");
  const source = `http://127.0.0.1:${address.port}/slow`;
  try {
    await withTempWorkspace(async (cwd) => {
      const run = await new PiIntegrationTest({
        testName: "read-caller-cancellation",
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        isolateUserResources: true,
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "cancelled",
                name: "codemode",
                arguments: {
                  code: `// @options: {"timeout_ms": 1000}\nconst result = await tools.read({path:${JSON.stringify(source)}});\nstore("unfinished", result);\ntext(result);`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "fresh",
                name: "codemode",
                arguments: {
                  code: `if(load("unfinished") !== undefined) throw Error("Cancelled Read was stored as complete");\nconst result = await tools.read({path:${JSON.stringify(source.replace("/slow", "/ok"))}});\nif(typeof result !== "string" || !result.endsWith("complete source\\n")) throw Error(result);\ntext(result);`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Cancel an unfinished Read and then read a fresh source.");
      expect(getToolExecution(run, "cancelled").isError).toBe(true);
      expect(getToolResultText(run, "cancelled")).toContain("read (cancelled)");
      expect(getToolResultText(run, "cancelled")).not.toContain("unfinished source bytes");
      expect(getToolExecution(run, "fresh").isError, getToolResultText(run, "fresh")).toBe(false);
      expect(slowRequests).toBe(1);
      expect(interrupted).toBe(true);
      const rendered = run.tuiRenderedOutput.replace(/\s+/gu, " ");
      expect(rendered).toContain(
        `Read cancelled for "${source}". No completed result was returned.`,
      );
      expect(rendered).not.toContain("unfinished source bytes");
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
