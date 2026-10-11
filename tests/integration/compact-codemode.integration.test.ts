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
  '// NATIVE_SCRIPT_MARKER\nawait tools.read({path:"note.txt"}); text("NATIVE_OUTPUT_MARKER");';

// IDE panels are optional; native Codemode rendering and model data are not.
test.each([
  { name: "default", preference: undefined, read: "full", visible: false },
  { name: "on", preference: "on", read: "full", visible: true },
  { name: "on-disabled-read", preference: "on", read: "disabled", visible: false },
])("Codemode $name controls only extra IDE panels", async ({ name, preference, read, visible }) => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "IDE_BODY_MARKER\n".repeat(4));
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    const file = path.join(cwd, ".pi/pi-agent-ide/extensions.json");
    const settings = { preferences: { "ui.codemode": preference, "ui.read": read } };
    await writeFile(file, JSON.stringify(settings));
    const run = await new PiIntegrationTest({
      testName: `codemode-tool-results-${name}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      tuiSize: { cols: 60, rows: 40 },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts"),
      ],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage([toolCall({ id: "parent", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Read a file silently and print an unrelated Codemode message");
    expect(getToolExecution(run, "parent").isError).toBe(false);
    expect(getToolResultText(run, "parent")).toContain("NATIVE_OUTPUT_MARKER");
    expect(getToolResultMessage(run, "parent").nestedCalls?.calls).toHaveLength(1);
    expect(run.tuiRenderedOutput).toContain("✓ read");
    expect(run.tuiRenderedOutput).toContain("NATIVE_SCRIPT_MARKER");
    expect(run.tuiRenderedOutput).toContain("NATIVE_OUTPUT_MARKER");
    expect(run.tuiRenderedOutput.includes("IDE_BODY_MARKER")).toBe(visible);
    expect(run.terminalOutput).not.toContain("\x1b[3J");
    const saved = await PiRun.open(run.artifacts.run);
    expect(saved.session).toContain("IDE_BODY_MARKER");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(settings)));
    if (name !== "default") return;
    const session = path.join(cwd, "saved.jsonl");
    await writeFile(session, saved.session ?? "");
    const expanded = await new PiIntegrationTest({
      testName: "codemode-tool-results-expanded-history",
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
    expect(expanded.tuiRenderedOutput).toContain("IDE_BODY_MARKER");
  });
});

test.each([false, true])("hidden IDE panels keep errors with caught=%s", async (caught) => {
  await withTempWorkspace(async (cwd) => {
    const script = caught
      ? 'try { await tools.read({path:"missing.txt"}); } catch {}'
      : 'await tools.read({path:"missing.txt"});';
    const run = await new PiIntegrationTest({
      testName: `codemode-tool-results-error-${caught}`,
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
          [toolCall({ id: "parent", name: "codemode", arguments: { code: script } })],
          {
            stopReason: "toolUse",
          },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Try a missing nested Read with IDE tool results hidden");
    expect(getToolExecution(run, "parent").isError).toBe(!caught);
    expect(run.tuiRenderedOutput).toContain("✗ read");
    expect(run.tuiRenderedOutput).toContain("Source not found");
  });
});
