import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocsPath } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  PiRun,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

import { expectToolRowsHaveBackground } from "#integration/support/tui-background.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each([false, true])(
  "special resource reads match native Pi and restore without files (expanded=%s)",
  async (expanded) => {
    const root = path.resolve(".agents/tmp/native-read-resources");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    try {
      await mkdir(path.join(cwd, "fixture/native-skill"), { recursive: true });
      const skill = "fixture/native-skill/SKILL.md";
      const agents = "fixture/AGENTS.override.md";
      const skillText = "# Native fixture\n\nSkillPayloadMarker\n";
      const agentText = "# Local context\n\nCONTEXT_CONTENT_MARKER\n";
      await writeFile(path.join(cwd, skill), skillText);
      await writeFile(path.join(cwd, agents), agentText);
      await mkdir(path.join(cwd, "fixture/annotated"), { recursive: true });
      await writeFile(path.join(cwd, "fixture/annotated/SKILL.md"), "VIEW_CONTENT_MARKER\n");
      await writeFile(path.join(cwd, "fixture/README.md"), "ORDINARY_CONTENT_MARKER\n");
      const options = {
        cwd,
        rawMode: false,
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".agents/tmp/test-runs")),
        tools: ["read"],
        timeoutMs: 60000,
        environment: { IDE_HISTORY_EXPANDED: expanded ? "1" : "0" },
      };
      const calls = [
        { id: "skill", args: { path: skill } },
        { id: "agents", args: { path: agents } },
        { id: "missing", args: { path: "fixture/missing/SKILL.md" } },
        { id: "docs", args: { path: path.join(getDocsPath(), "skills.md"), offset: 1, limit: 3 } },
      ];
      const conversation = [
        assistantMessage(
          calls.map(({ id, args }) => toolCall({ id, name: "read", arguments: args })),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished")]),
      ];
      const historyFixture = path.resolve("tests/integration/fixtures/restore-tool-history.ts");
      const baseline = await new PiIntegrationTest({
        ...options,
        testName: `native-resource-baseline-${expanded}`,
        extensions: [historyFixture],
        conversation,
      }).run("Read the three resources.");
      const run = await new PiIntegrationTest({
        ...options,
        testName: `native-resource-ide-${expanded}`,
        extensions: [path.resolve("src/pi-agent-ide.ts"), historyFixture],
        conversation: [
          conversation[0],
          assistantMessage(
            [
              toolCall({
                id: "view",
                name: "read",
                arguments: { path: "fixture/annotated/SKILL.md", views: ["lines"] },
              }),
              toolCall({ id: "ordinary", name: "read", arguments: { path: "fixture/README.md" } }),
            ],
            { stopReason: "toolUse" },
          ),
          conversation[1],
        ],
      }).run("Read the three resources.");
      for (const id of ["skill", "agents", "docs"])
        expect(getToolExecution(run, id).isError).toBe(false);
      expect(getToolExecution(run, "missing").isError).toBe(true);
      expect(run.tuiRenderedOutput).toContain("missing/SKILL.md");
      expect(run.tuiRenderedOutput).toContain("VIEW_CONTENT_MARKER");
      expect(run.tuiRenderedOutput).toContain("ORDINARY_CONTENT_MARKER");
      // Compare actual native headers, not copies of their wording.
      const headers = (output: string) =>
        output
          .split(/\n[ \t]*\n/u)
          .map((block) =>
            block
              .split("\n")
              .map((line) => line.trim())
              .join(""),
          )
          .filter((line) =>
            ["native-skill", "AGENTS.override.md", "docs/skills.md"].some((label) =>
              line.includes(label),
            ),
          );
      expect(headers(baseline.tuiRenderedOutput)).toHaveLength(3);
      expect(headers(run.tuiRenderedOutput)).toEqual(headers(baseline.tuiRenderedOutput));

      expectToolRowsHaveBackground(run.terminalOutput, "native-skill");
      if (expanded) expectToolRowsHaveBackground(run.terminalOutput, "SkillPayloadMarker");
      for (const marker of ["SkillPayloadMarker", "CONTEXT_CONTENT_MARKER"]) {
        expect(run.tuiRenderedOutput.includes(marker)).toBe(expanded);
        expect(baseline.tuiRenderedOutput.includes(marker)).toBe(expanded);
      }
      const capture = await PiRun.open(run.artifacts.run);
      if (!capture.session) throw new Error("Missing saved session");
      const saved = path.join(cwd, "saved.jsonl");
      await writeFile(saved, capture.session);
      await rm(path.join(cwd, "fixture"), { recursive: true });
      const resumed = await new PiIntegrationTest({
        ...options,
        testName: `native-resource-restored-${expanded}`,
        extensions: [path.resolve("src/pi-agent-ide.ts"), historyFixture],
        environment: { ...options.environment, IDE_RESTORE_SESSION: saved },
        conversation: [assistantMessage([text("Restored")])],
      }).run("/restore-tool-history");
      expect(headers(resumed.tuiRenderedOutput)).toEqual(headers(run.tuiRenderedOutput));
      for (const marker of ["SkillPayloadMarker", "CONTEXT_CONTENT_MARKER"])
        expect(resumed.tuiRenderedOutput.includes(marker)).toBe(expanded);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);
