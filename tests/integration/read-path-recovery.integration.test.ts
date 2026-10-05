import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("missing Read paths suggest real files without reading them", async () => {
  const root = path.resolve(".tmp/read-path-recovery-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src/read-renderer.ts"), "DO_NOT_READ_CANDIDATE\n");
    await writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
    await mkdir(path.join(cwd, "ignored"));
    await writeFile(path.join(cwd, "ignored/read-render.ts"), "ignored\n");
    const run = await new PiIntegrationTest({
      testName: "read-path-recovery",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({ id: "typo", name: "read", arguments: { path: "src/read-render.ts" } }),
            toolCall({
              id: "directory",
              name: "read",
              arguments: { path: "wrong/read-renderer.ts" },
            }),
            toolCall({
              id: "url",
              name: "read",
              arguments: { path: pathToFileURL(path.join(cwd, "src/read-rendere.ts")).href },
            }),
            toolCall({
              id: "unrelated",
              name: "read",
              arguments: { path: "totally-unrelated.xyz" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished")]),
      ],
    }).run("Read the requested files.");
    for (const id of ["typo", "directory", "url"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError).toBe(true);
      expect(getToolResultText(run, id)).toContain("Possible matches:");
      expect(getToolResultText(run, id)).toContain("src/read-renderer.ts");
      expect(getToolResultText(run, id)).not.toContain("ignored/read-render.ts");
      expect(execution.result).not.toHaveProperty("structuredContent");
      expect(getToolResultText(run, id)).not.toContain("DO_NOT_READ_CANDIDATE");
    }
    expect(getToolResultText(run, "unrelated")).not.toContain("Possible matches:");
    expect(run.tuiRenderedOutput).toContain("Possible matches:");
    expect(run.tuiRenderedOutput).not.toContain("DO_NOT_READ_CANDIDATE");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
