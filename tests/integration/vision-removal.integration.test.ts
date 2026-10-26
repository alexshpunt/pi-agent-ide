import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

// Load IDE alone: Computer Use may independently provide its own visual resources.
test("removes desktop and process resources without replacing requested web images with text", async () => {
  const root = path.resolve(".tmp/vision-removal");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<html><title>Web text</title><body><main>retained-web-marker-890</main></body></html>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}/`;
  const removed = [
    `process:${process.pid}`,
    "process:ssh://missing/1",
    `window:${process.pid}`,
    "window:ssh://missing/1",
    "display:",
    "display:ssh://missing/",
  ];
  const captures = [
    { path: url, views: ["image"] },
    { path: url, views: ["sequence:duration=0.1,interval=0.1"] },
    { path: "web:ssh://missing/https://example.invalid/", views: ["image"] },
    { path: "web:ssh://missing/https://example.invalid/", views: ["sequence"] },
  ];
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
  try {
    const run = await new PiIntegrationTest({
      testName: "vision-removal",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      piCommand: process.env.PI_COMMAND ?? "pi",
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "search"],
      conversation: [
        ...removed.map((source, index) => call(`removed-${index}`, "read", { path: source })),
        ...captures.map((args, index) => call(`capture-${index}`, "read", args)),
        call("web-text", "read", { path: url }),
        call("web-search", "search", { path: url, query: "retained-web-marker-890" }),
        assistantMessage([text("Verified retained website text.")]),
      ],
    }).run("Check unsupported visual resources and read the synthetic website as text.");
    for (const [index] of removed.entries())
      expect.soft(getToolExecution(run, `removed-${index}`).isError).toBe(true);
    for (const [index] of captures.entries()) {
      const execution = getToolExecution(run, `capture-${index}`);
      expect.soft(execution.isError).toBe(true);
      expect.soft(getToolExecutionDetails(execution)).toMatchObject({
        failure: { code: "UNSUPPORTED_CAPABILITY" },
      });
      expect
        .soft(getToolResultText(run, `capture-${index}`))
        .not.toContain("retained-web-marker-890");
    }
    for (const id of ["web-text", "web-search"]) {
      expect(getToolExecution(run, id).isError).toBe(false);
      expect(getToolResultText(run, id)).toContain("retained-web-marker-890");
    }
    const tools = getCurrentTools(run.providerRequests[0]?.messages as Message[]);
    const read = tools.find((tool) => tool.name === "read");
    const search = tools.find((tool) => tool.name === "search");
    for (const prefix of ["process:", "window:", "display:"])
      expect(JSON.stringify(read?.parameters)).not.toContain(prefix);
    expect(JSON.stringify(search?.parameters)).not.toContain("process:<query>");
    expect(run.tuiRenderedOutput).toContain("retained-web-marker-890");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
