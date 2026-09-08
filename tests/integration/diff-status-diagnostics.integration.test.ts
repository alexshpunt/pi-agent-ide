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
import type { DiagnosticEntryData } from "#src/core/diagnostic-entry.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each([false, true])(
  "plugin diff statuses and UI-only diagnostics survive real Pi session restore (expanded=%s)",
  async (expanded) => {
    const root = path.resolve(".agents/tmp/diff-status-diagnostics");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true }),
      );
      const files = ["first.case", "second.case"];
      for (const file of files) await writeFile(path.join(cwd, file), "before\n");
      const options = {
        cwd,
        rawMode: false,
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".agents/tmp/test-runs")),
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/fixtures/diff-status-diagnostics.ts"),
          path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
        ],
        tools: ["replace", "await_diagnostics"],
        environment: { IDE_HISTORY_EXPANDED: expanded ? "1" : "0" },
        timeoutMs: 60000,
      };
      const run = await new PiIntegrationTest({
        ...options,
        testName: expanded ? "diff-status-diagnostics-expanded" : "diff-status-diagnostics",
        conversation: [
          assistantMessage(
            files.map((file) =>
              toolCall({
                id: file,
                name: "replace",
                arguments: { path: file, start: "before", text: "after   " },
              }),
            ),
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "await", name: "await_diagnostics", arguments: {} })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Finished")]),
        ],
      }).run("Edit both files and wait for their diagnostic reports.");
      for (const file of files) {
        expect(await readFile(path.join(cwd, file), "utf8")).toBe("after\n");
        const execution = getToolExecution(run, file);
        expect(execution.isError).toBe(false);
        const details = getToolExecutionDetails(execution) as {
          results: { data: { formatting: unknown; diffStatuses: unknown[] } }[];
          mutationRender: { diffStatuses: unknown[] }[];
        };
        expect(details.results[0]?.data.formatting).toEqual({
          status: "changed",
          formatter: "fixture-format",
        });
        expect(details.results[0]?.data.diffStatuses).toEqual([
          expect.objectContaining({ tone: "success" }) as unknown,
          { text: `checked-${file}`, tone: "muted" },
        ]);
        expect(details.mutationRender[0]?.diffStatuses).toEqual(
          details.results[0]?.data.diffStatuses,
        );
        expect(run.tuiRenderedOutput).toContain(`checked-${file}`);
      }
      expect(run.tuiRenderedOutput).not.toContain("private-fixture-detail");
      const captured = await PiRun.open(run.artifacts.run);
      if (!captured.session) throw new Error("Missing session capture");
      const entries = captured.session
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { type: string; customType?: string; data?: DiagnosticEntryData },
        );
      const summaries = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === "ide-diagnostic-summary",
      ) as { data: DiagnosticEntryData }[];
      for (const file of files) {
        expect(
          summaries.some(
            ({ data }) =>
              data.filePath === file &&
              data.sources.some(
                (source) =>
                  source.source === "fixture-check" &&
                  source.status === "snapshot" &&
                  source.counts.error === 1 &&
                  source.counts.warning === 1,
              ),
          ),
        ).toBe(true);
      }
      expect(JSON.stringify(run.providerRequests)).not.toContain("ide-diagnostic-summary");
      const modelContent = run.providerRequests.flatMap((request) =>
        (request.messages as { content: unknown }[]).map((message) => message.content),
      );
      expect(JSON.stringify(modelContent)).not.toContain("checked-first.case");
      const session = path.join(cwd, "saved.jsonl");
      await writeFile(session, captured.session);
      for (const file of files) await rm(path.join(cwd, file));
      const resumed = await new PiIntegrationTest({
        ...options,
        testName: expanded
          ? "diff-status-diagnostics-restored-expanded"
          : "diff-status-diagnostics-restored",
        environment: { ...options.environment, IDE_RESTORE_SESSION: session },
        conversation: [assistantMessage([text("Restored")])],
      }).run("/restore-tool-history");
      for (const file of files) expect(resumed.tuiRenderedOutput).toContain(`checked-${file}`);
      // Compare the actual summary rows rather than asserting their explanatory wording.
      const rows = (output: string) =>
        output
          .split("\n")
          .filter((line) => line.includes(".case · ") && !line.trimStart().startsWith("replace "));
      expect(rows(run.tuiRenderedOutput).length).toBeGreaterThan(0);
      expect(rows(resumed.tuiRenderedOutput)).toEqual(rows(run.tuiRenderedOutput));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);
