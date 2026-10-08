import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolCallNames,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const root = path.resolve();
const workspace = path.join(root, ".tmp/terminal-steering/workspace");
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

for (const method of ["prompt", "steer", "followUp"]) {
  test.runIf(process.platform !== "win32")(
    `terminal wait yields to ${method === "followUp" ? "neither follow-up nor its input transform" : `${method} steering after input transforms`}`,
    async () => {
      await mkdir(workspace, { recursive: true });
      const result = await new PiIntegrationTest({
        testName: `terminal-steering-${method}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        cwd: workspace,
        extensions: [
          path.join(root, "src/pi-agent-ide.ts"),
          path.join(root, "tests/integration/fixtures/terminal-steering.ts"),
        ],
        tools: ["bash"],
        rawMode: false,
        environment: { SHELL: "/bin/bash", PI_TERMINAL_STEERING_METHOD: method },
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "steering-terminal",
                name: "bash",
                arguments: {
                  command: "printf ready; sleep 2.5; printf terminal-steering-finished",
                  timeoutSeconds: 30,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Handled the next input.")]),
          assistantMessage([text("Handled completion or follow-up.")]),
        ],
      }).run("Start a long foreground terminal command");

      const details = getToolExecutionDetails(getToolExecution(result, "steering-terminal")) as {
        elapsedMs: number;
        source: string;
      };
      expect(getToolCallNames(result)).toEqual(["bash"]);
      expect(JSON.stringify(result.traceEvents)).not.toContain("terminal-steering-error");
      if (method === "followUp") {
        expect(details).toMatchObject({ status: "completed", background: false, exitCode: 0 });
        expect(details.elapsedMs).toBeGreaterThanOrEqual(2_400);
        expect(details).not.toHaveProperty("waitReason");
      } else {
        expect(details).toMatchObject({
          status: "running",
          background: true,
          waitReason: "steering",
        });
        expect(details.elapsedMs).toBeLessThan(2_000);
        expect(JSON.stringify(result.providerRequests[1])).toContain(
          "terminal-steering-transformed",
        );
        const trace = JSON.stringify(result.traceEvents);
        expect(trace).toContain("terminal-completion");
        expect(trace).toContain("terminal-steering-finished");
        expect(result.tuiRenderedOutput).toContain("background · steering");
        expect(result.tuiRenderedOutput).toContain("terminal-steering-finished");
      }
    },
  );
}
