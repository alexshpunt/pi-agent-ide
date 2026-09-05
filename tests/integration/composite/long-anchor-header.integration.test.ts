import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const root = path.resolve();

for (const expanded of [false, true]) {
  test(`bounds multiline mutation arguments with expanded=${expanded}`, async () => {
    const parent = path.join(root, ".agents/tmp/long-anchor-header");
    await mkdir(parent, { recursive: true });
    const cwd = await mkdtemp(path.join(parent, "workspace-"));
    const anchor = Array.from(
      { length: 100 },
      (_, index) => `    old_value_${index} = calculate_value(${index})`,
    ).join("\n");
    const source = `HEADER\n${anchor}\nFOOTER\n`;
    try {
      await writeFile(path.join(cwd, "monitor.txt"), source);
      const result = await new PiIntegrationTest({
        testName: `long-anchor-header-${expanded ? "expanded" : "collapsed"}`,
        artifactsDir: testArtifactsDir(
          import.meta.filename,
          path.join(root, ".agents/tmp/test-runs"),
        ),
        cwd,
        extensions: [
          path.join(root, "src/pi-agent-ide.ts"),
          path.join(root, "tests/integration/fixtures/restore-tool-history.ts"),
        ],
        environment: { IDE_HISTORY_EXPANDED: expanded ? "1" : "0" },
        isolateUserResources: true,
        rawMode: false,
        tools: ["read", "replace"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "before", name: "read", arguments: { path: "monitor.txt" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-long",
                name: "replace",
                arguments: {
                  path: "monitor.txt",
                  start: anchor,
                  end: anchor,
                  text: "updated_value = 1",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the long exact range and show the native tool panel");
      expect(getToolExecution(result, "replace-long").isError).not.toBe(true);
      expect(await readFile(path.join(cwd, "monitor.txt"), "utf8")).toBe(
        "HEADER\nupdated_value = 1\nFOOTER\n",
      );
      const rows = result.tuiRenderedOutput.split("\n");
      const header = rows.findIndex((row) => row.includes("replace monitor.txt"));
      expect(header).toBeGreaterThanOrEqual(0);
      const panel = rows.findIndex((row, index) => index > header && row.includes("╭"));
      expect(panel).toBeGreaterThan(header);
      expect(panel - header).toBeLessThanOrEqual(expanded ? 12 : 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
}
