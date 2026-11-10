import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

const preload = path.resolve("tests/integration/fixtures/no-account-entry-preload.mjs");

test.runIf(process.platform !== "win32")(
  "loads and runs its tools when the current user has no account entry",
  async () => {
    const root = path.resolve(".agents/tmp/no-account-entry");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ preset: "full", noAnimations: true, noPostProcessing: true }),
      );
      await writeFile(path.join(cwd, "note.txt"), "hello\n");
      const result = await new PiIntegrationTest({
        testName: "no-account-entry",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        // Without SHELL the terminal would ask the account database for the user's shell.
        environment: { NODE_OPTIONS: `--import=${preload}`, SHELL: "" },
        tools: ["read", "bash"],
        conversation: [
          assistantMessage(
            [
              toolCall({ id: "read", name: "read", arguments: { path: "note.txt" } }),
              toolCall({ id: "shell", name: "bash", arguments: { command: "printf shell-ok" } }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Read the note and run a command.");
      expect(getToolExecution(result, "read").isError).toBe(false);
      expect(getToolExecution(result, "shell").isError).toBe(false);
      expect(getToolResultText(result, "shell")).toContain("shell-ok");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
