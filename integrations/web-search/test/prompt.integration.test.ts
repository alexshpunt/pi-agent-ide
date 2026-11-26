import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("exposes web and image search tools to the model through real Pi", async () => {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "web-search-prompt-"));
  try {
    const result = await new PiIntegrationTest({
      piCommand: path.resolve(
        path.dirname(import.meta.dirname),
        "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      testName: "web-search-prompt",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve(path.dirname(import.meta.dirname), "index.ts")],
      tools: ["web_search", "image_search"],
      isolateUserResources: true,
      conversation: [assistantMessage([text("Ready")])],
    }).run("Check the available research instructions");

    const declarations = getCurrentTools((result.providerRequests[0]?.messages ?? []) as Message[]);
    const names = declarations.map((tool) => tool.name);
    expect(names).toContain("web_search");
    expect(names).toContain("image_search");
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
