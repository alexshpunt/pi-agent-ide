import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve();

test.runIf(process.platform === "win32")(
  "exposes PowerShell syntax and runs it on Windows",
  async () => {
    const parent = path.join(root, ".tmp", "windows-shell-guidance");
    await mkdir(parent, { recursive: true });
    const workspace = await mkdtemp(path.join(parent, "workspace-"));
    try {
      const result = await new PiIntegrationTest({
        testName: "windows-shell-guidance",
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp", "test-runs")),
        cwd: workspace,
        isolateUserResources: true,
        extensions: [path.join(root, "src", "pi-agent-ide.ts")],
        tools: ["powershell"],
        rawMode: false,
        transport: "rpc",
        environment: { SHELL: "powershell.exe" },
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "windows-shell",
                name: "powershell",
                arguments: {
                  command: "Write-Output ('LPT-361-Windows-' + $env:OS)",
                  timeoutSeconds: 10,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Windows shell verified.")]),
        ],
      }).run("Run a command using the shell syntax declared by the tool");

      const declarations = getCurrentTools(result.providerRequests[0]?.messages as Message[]);
      const shell = declarations.find((tool) => tool.name === "powershell");
      expect(shell?.description).toContain("Windows PowerShell");
      const schema = JSON.stringify(shell?.parameters);
      expect(schema).toContain("Write PowerShell syntax");
      expect(schema).toContain("$env:NAME");
      expect(schema).not.toContain("configured system shell");
      const execution = getToolExecution(result, "windows-shell");
      expect(execution.isError).toBe(false);
      expect(getToolExecutionDetails(execution)).toMatchObject({
        shell: "Windows PowerShell",
        shellFamily: "powershell",
        status: "completed",
        exitCode: 0,
      });
      expect(getToolResultText(result, "windows-shell")).toContain("LPT-361-Windows-Windows_NT");
      expect(getToolResultText(result, "windows-shell")).toContain("do not infer syntax");
      expect(result.state?.mode).toBe("rpc");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
