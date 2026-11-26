import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const once = { chunks: { kind: "fixed" as const, size: Number.MAX_SAFE_INTEGER } };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args, ...once })], { stopReason: "toolUse" });

test("web search capability fixture supports resource reads and search", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "web-capability-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/websearch.json"),
      JSON.stringify({ providers: [{ provider: "serper", apiKey: "fixture-key" }] }),
    );
    const root = process.cwd();
    const result = await new PiIntegrationTest({
      testName: "web-search-capability-fixture",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        path.join(root, "src/pi-agent-ide.ts"),
        path.join(root, "integrations/web-search/test/fixtures/serper-transport.ts"),
        path.join(root, "integrations/web-search/index.ts"),
      ],
      tools: ["web_search", "image_search", "read", "search"],
      timeoutMs: 90000,
      conversation: [
        call("web", "web_search", { query: "fixture search", limit: 10 }),
        call("page", "read", { path: "websearch:web", offset: 11, limit: 2 }),
        call("find", "search", { path: "websearch:web", query: "r/12" }),
        call("image", "image_search", { query: "fixture image", limit: 2 }),
        call("images", "read", { path: "websearch:image", offset: 95, limit: 2 }),
        assistantMessage([text("Done", once)]),
      ],
    }).run("Exercise the deterministic web search fixture.");
    for (const id of ["web", "page", "find", "image", "images"])
      expect(getToolExecution(result, id).isError, id).toBe(false);
    expect(getToolResultText(result, "page")).toContain("Result 11");
    expect(getToolResultText(result, "find")).toContain("Result 12");
    expect(getToolResultText(result, "images")).toContain("https://img.example/95.jpg");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
