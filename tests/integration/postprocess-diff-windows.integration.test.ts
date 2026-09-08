import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  PiRun,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

interface Model {
  rows: { text: string; changed: boolean; afterLine?: number }[];
  omittedChanges: { outside: number; ambiguous: number };
}

test.each([false, true])(
  "batch local windows survive postprocessing and history restore (expanded=%s)",
  async (expanded) => {
    const root = path.resolve(".agents/tmp/postprocess-diff-windows");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/text-editor.json"),
        JSON.stringify({ renderer: { diffView: "compact" } }),
      );
      await writeFile(
        path.join(cwd, "local.case"),
        Array.from({ length: 30 }, (_, i) => `const value${i + 1} = ${i + 1};`).join("\n") + "\n",
      );
      const options = {
        cwd,
        rawMode: false,
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".agents/tmp/test-runs")),
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/fixtures/postprocess-diff-windows.ts"),
          path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
        ],
        tools: ["replace"],
        environment: { IDE_HISTORY_EXPANDED: expanded ? "1" : "0" },
        timeoutMs: 60000,
      };
      const run = await new PiIntegrationTest({
        ...options,
        testName: `postprocess-windows-${expanded}`,
        conversation: [
          assistantMessage(
            [10, 12].map((n) =>
              toolCall({
                id: `edit${n}`,
                name: "replace",
                arguments: {
                  path: "local.case",
                  start: `const value${n} = ${n};`,
                  text: `const value${n} = build(${n});`,
                },
              }),
            ),
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Finished")]),
        ],
      }).run("Edit the two local calls.");
      const models = [10, 12].map((n) => {
        const execution = getToolExecution(run, `edit${n}`);
        expect(execution.isError).toBe(false);
        const details = getToolExecutionDetails(execution) as {
          mutationRender: { model: Model }[];
        };
        const model = details.mutationRender[0]?.model;
        expect(model).toBeDefined();
        expect(model.omittedChanges).toEqual({ outside: 1, ambiguous: 0 });
        const changed = model.rows
          .filter((row) => row.changed)
          .map((row) => row.text)
          .join("\n");
        expect(changed).toContain(`arg${n}_15`);
        expect(changed).not.toContain(`arg${n === 10 ? 12 : 10}_`);
        expect(changed).not.toContain("unrelated header");
        return model;
      });
      expect(
        models[0]?.rows.find((row) => row.text.startsWith("const value10 = build"))?.afterLine,
      ).toBe(11);
      expect(await readFile(path.join(cwd, "local.case"), "utf8")).toContain("arg12_15");
      const capture = await PiRun.open(run.artifacts.run);
      if (!capture.session) throw new Error("Missing session capture");
      const session = path.join(cwd, "saved.jsonl");
      await writeFile(session, capture.session);
      await rm(path.join(cwd, "local.case"));
      const resumed = await new PiIntegrationTest({
        ...options,
        testName: `postprocess-windows-restored-${expanded}`,
        environment: { ...options.environment, IDE_RESTORE_SESSION: session },
        conversation: [assistantMessage([text("Restored")])],
      }).run("/restore-tool-history");
      const diffRows = (output: string) =>
        output
          .split("\n")
          .filter(
            (row) =>
              row.includes("arg10_") || row.includes("arg12_") || row.includes("window-format"),
          );
      expect(diffRows(run.tuiRenderedOutput).length).toBeGreaterThan(0);
      expect(diffRows(resumed.tuiRenderedOutput)).toEqual(diffRows(run.tuiRenderedOutput));
      if (expanded) expect(resumed.tuiRenderedOutput).toContain("arg10_15");

      const bodyRows = resumed.tuiRenderedOutput
        .split("\n")
        .filter((row) => row.trimStart().startsWith("│"));
      if (expanded) expect(bodyRows.length).toBeGreaterThan(24);
      else expect(bodyRows).toHaveLength(24);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);
