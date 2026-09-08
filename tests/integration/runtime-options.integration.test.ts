import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(".agents/tmp/runtime-options");
const extensions = [
  path.resolve("src/pi-agent-ide.ts"),
  path.resolve("tests/integration/fixtures/runtime-options.ts"),
];

for (const mode of ["default", "config", "flags"] as const) {
  test(`runtime options through ${mode} keep explicit diagnostics and final edits`, async () => {
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, `${mode}-`));
    const disabled = mode !== "default";
    try {
      await writeFile(path.join(cwd, "example.fixture"), "old\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: mode === "config", noPostProcessing: mode === "config" }),
      );
      const wrapper = path.join(cwd, "launch-pi");
      if (mode === "flags") {
        await writeFile(
          wrapper,
          '#!/bin/sh\nexec pi --pi-agent-ide-no-animations --pi-agent-ide-no-post-processing "$@"\n',
        );
        await chmod(wrapper, 0o755);
      }
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const result = await new PiIntegrationTest({
        testName: `runtime-options-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions,
        ...(mode === "flags" ? { piCommand: wrapper } : {}),
        tools: ["read", "replace", "runtime_options_probe"],
        rawMode: false,
        conversation: [
          call("edit", "replace", { path: "example.fixture", start: "old", text: "new   " }),
          call("before", "runtime_options_probe", {}),
          call("diagnostics", "read", { path: "diagnostics:example.fixture" }),
          call("after", "runtime_options_probe", {}),
          call("anchors", "read", { path: "example.fixture", views: ["anchors"] }),
          call("removed-view", "read", { path: "example.fixture", views: ["lines"] }),
          assistantMessage([text("Done")]),
        ],
      }).run("Make the requested edit, then inspect explicit diagnostics and source views.");
      expect(getToolExecution(result, "edit").isError).toBe(false);

      expect(getToolExecutionDetails(getToolExecution(result, "edit"))).toMatchObject({
        results: [
          {
            data: {
              operations: [{ operation: "replace", changes: 1 }],
              formatting: { status: disabled ? "disabled" : "changed" },
            },
          },
        ],
      });
      expect(await readFile(path.join(cwd, "example.fixture"), "utf8")).toBe(
        disabled ? "new   \n" : "new\n",
      );
      const before = getToolExecutionDetails(getToolExecution(result, "before")) as {
        formats: number;
        diagnostics: number;
      };
      expect(before.formats).toBe(disabled ? 0 : 1);
      if (disabled) expect(before.diagnostics).toBe(0);
      expect(getToolExecution(result, "diagnostics").isError).toBe(false);
      const after = getToolExecutionDetails(getToolExecution(result, "after")) as {
        diagnostics: number;
      };
      expect(after.diagnostics).toBeGreaterThan(0);
      expect(getToolExecutionDetails(getToolExecution(result, "removed-view"))).toMatchObject({
        ignoredViews: ["lines"],
      });
      expect(getToolExecution(result, "anchors").isError).toBe(false);

      expect(getToolResultText(result, "anchors")).toMatch(/1#[A-Z0-9]+\|new/u);
      // Save the real effective prompt for human review; do not assert its prose.
      await writeFile(
        path.join(result.artifacts.directory, "system-prompt.txt"),
        getProviderSystemPrompt(result),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
}
