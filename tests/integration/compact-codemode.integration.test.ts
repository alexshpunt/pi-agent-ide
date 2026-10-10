import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const code =
  "// SCRIPT_DETAIL_MARKER\n".repeat(40) +
  'const result = await tools.read({path:"note.txt"}); text(result); text("SCRIPT_OUTPUT_MARKER");';

// Exercise real Codemode, native summaries and the separate retained IDE panels together.
test("compact Codemode hides bodies without losing native summaries or agent data", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "NESTED_BODY_MARKER\n".repeat(40));
    const run = await new PiIntegrationTest({
      testName: "compact-codemode",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      tuiSize: { cols: 60, rows: 40 },
      extensions: [
        path.resolve(process.env.IDE_CODEMODE_EXTENSION ?? "src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts"),
      ],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: { code },
              chunks: { kind: "fixed", size: 48 },
              delayMs: 3,
            }),
          ],
          {
            stopReason: "toolUse",
          },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read and print a file through Codemode");
    expect(getToolExecution(run, "parent").isError).toBe(false);
    expect(getToolResultText(run, "parent")).toContain("SCRIPT_OUTPUT_MARKER");
    expect(getToolResultText(run, "parent")).toContain("NESTED_BODY_MARKER");
    expect(getToolResultMessage(run, "parent").nestedCalls?.calls).toHaveLength(1);
    expect(run.tuiRenderedOutput).toContain("✓ read");
    expect(run.tuiRenderedOutput).toContain("note.txt");
    expect(run.tuiRenderedOutput).not.toContain("SCRIPT_DETAIL_MARKER");
    expect(run.tuiRenderedOutput).not.toContain("SCRIPT_OUTPUT_MARKER");
    expect(run.tuiRenderedOutput).not.toContain("NESTED_BODY_MARKER");
    expect(run.terminalOutput).not.toContain("SCRIPT_DETAIL_MARKER");
    expect(run.terminalOutput).not.toContain("\x1b[3J");
    const saved = await PiRun.open(run.artifacts.run);
    expect(saved.session).toContain("SCRIPT_DETAIL_MARKER");
    expect(saved.session).toContain("NESTED_BODY_MARKER");
    const session = path.join(cwd, "saved.jsonl");
    await writeFile(session, saved.session ?? "");
    const expanded = await new PiIntegrationTest({
      testName: "compact-codemode-expanded-history",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      tuiSize: { cols: 60, rows: 50 },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
      ],
      tools: ["read"],
      environment: {
        IDE_RESTORE_SESSION: session,
        IDE_HISTORY_EXPANDED: "1",
        IDE_HISTORY_THEME: "light",
      },
      conversation: [assistantMessage([text("Restored")])],
    }).run("/restore-tool-history");
    expect(expanded.tuiRenderedOutput).toContain("SCRIPT_DETAIL_MARKER");
    expect(expanded.tuiRenderedOutput).toContain("SCRIPT_OUTPUT_MARKER");
    expect(expanded.tuiRenderedOutput).toContain("NESTED_BODY_MARKER");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "NESTED_BODY_MARKER\n".repeat(40),
    );
  });
});

test("compact Codemode keeps failed calls and actionable script errors", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "compact-codemode-error",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts"),
      ],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "failed",
              name: "codemode",
              arguments: {
                code: '// HIDDEN_FAILED_SCRIPT\nawait tools.read({path:"missing.txt"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Stopped")]),
      ],
    }).run("Try to read an absent file through Codemode");
    expect(getToolExecution(run, "failed").isError).toBe(true);
    expect(getToolResultText(run, "failed")).toContain("missing.txt");
    expect(run.tuiRenderedOutput).toContain("✗ read");
    expect(run.tuiRenderedOutput).toContain("Source not found");
    expect(run.tuiRenderedOutput).not.toContain("HIDDEN_FAILED_SCRIPT");
  });
});

test("compact Codemode keeps a caught child failure actionable", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "compact-codemode-caught-error",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts"),
      ],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "caught",
              name: "codemode",
              arguments: { code: 'try { await tools.read({path:"missing.txt"}); } catch {}' },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Catch a failed nested Read without printing its result");
    expect(getToolExecution(run, "caught").isError).toBe(false);
    expect(run.tuiRenderedOutput).toContain("✗ read");
    expect(run.tuiRenderedOutput).toContain("Source not found");
  });
});

test.each(["detailed", "deadline"] as const)("Codemode %s survives real startup", async (mode) => {
  await withTempWorkspace(async (cwd) => {
    const preference = mode === "detailed" ? "full" : "compact";
    const settings = { preferences: { "ui.codemode": preference, unrelated: "keep" } };
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    const file = path.join(cwd, ".pi/pi-agent-ide/extensions.json");
    await writeFile(file, JSON.stringify(settings));
    const script =
      mode === "detailed"
        ? '// DETAILED_SCRIPT_MARKER\ntext("DETAILED_OUTPUT_MARKER");'
        : '// @options: {"timeout_ms":1000}\n// DEADLINE_SCRIPT_MARKER\nwhile (true) {}';
    const run = await new PiIntegrationTest({
      testName: `codemode-${mode}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts"),
      ],
      tools: ["codemode"],
      conversation: [
        assistantMessage([toolCall({ id: mode, name: "codemode", arguments: { code: script } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Run Codemode with saved preferences");
    expect(getToolExecution(run, mode).isError).toBe(mode === "deadline");
    if (mode === "detailed") {
      expect(run.tuiRenderedOutput).toContain("DETAILED_SCRIPT_MARKER");
      expect(run.tuiRenderedOutput).toContain("DETAILED_OUTPUT_MARKER");
    } else {
      expect(run.tuiRenderedOutput).toMatch(/timeout|timed out|deadline/i);
      expect(run.tuiRenderedOutput).not.toContain("DEADLINE_SCRIPT_MARKER");
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });
});
