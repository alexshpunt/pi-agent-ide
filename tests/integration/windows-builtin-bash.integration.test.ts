import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

/** The system prompt lists each active tool as "- name: snippet"; scripted calls in the message history do not. */
const lists = (request: unknown, name: string): boolean =>
  new RegExp(`^- ${name}: `, "mu").test((request as { systemPrompt?: string }).systemPrompt ?? "");

test.skipIf(process.platform !== "win32")(
  "a native Windows session offers PowerShell and never Pi's built-in bash, before and after reload",
  async () => {
    const base = path.resolve(".tmp/windows-builtin-bash-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: [
            "ide.ast",
            "ide.lsp",
            "ide.formatter",
            "ide.lint",
            "ide.changes",
            "ide.diagnostics",
            "ide.debugger",
          ],
        }),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })]);
      // No `tools` option: Pi's own default tool set (read, bash, edit, write) stays in effect.
      const run = await new PiIntegrationTest({
        testName: "windows-builtin-bash",
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/support/tool-exposure-reload-extension.ts"),
        ],
        timeoutMs: 120_000,
        conversation: [
          call("bash-before", "bash", { command: "echo MUST-NOT-RUN" }),
          call("ps-before", "powershell", { command: "Write-Output PS-BEFORE-RELOAD" }),
          assistantMessage([text("First turn done.")]),
          call("bash-after", "bash", { command: "echo MUST-NOT-RUN" }),
          call("ps-after", "powershell", { command: "Write-Output PS-AFTER-RELOAD" }),
          assistantMessage([text("Second turn done.")]),
        ],
      }).run("/reload-check");

      for (const id of ["bash-before", "bash-after"]) {
        expect(getToolExecution(run, id).isError, id).toBe(true);
        expect(getToolResultText(run, id), id).not.toContain("MUST-NOT-RUN");
      }
      expect(getToolExecution(run, "ps-before").isError).toBe(false);
      expect(getToolResultText(run, "ps-before")).toContain("PS-BEFORE-RELOAD");
      expect(getToolResultText(run, "ps-before")).toContain("shell: Windows PowerShell");
      expect(getToolExecution(run, "ps-after").isError).toBe(false);
      expect(getToolResultText(run, "ps-after")).toContain("PS-AFTER-RELOAD");

      expect(run.providerRequests.length).toBeGreaterThanOrEqual(6);
      for (const request of run.providerRequests) {
        expect(lists(request, "powershell")).toBe(true);
        expect(lists(request, "bash")).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
