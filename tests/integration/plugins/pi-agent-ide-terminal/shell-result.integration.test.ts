import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

test.runIf(process.platform !== "win32")(
  "native scripts compose readable shell results without expanding the preview",
  async () => {
    const root = path.resolve(".tmp/shell-result");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      // Keep the wait blocked on stdin until Pi shuts down. Completion delivery has its own test;
      // a short sleep can finish during an existing turn and never request an extra response.
      const code = `
      const empty = await tools.bash({command: "true"});
      let failed;
      try { await tools.bash({command: "printf bad; exit 7"}); throw Error("Expected exit-7 refusal"); }
      catch (error) { failed = String(error); if (!failed.includes("exitCode: 7")) throw error; }
      const large = await tools.bash({command: ${JSON.stringify('node -e \'process.stdout.write("HEAD" + "я".repeat(700000) + "TAIL")\'')}});
      const waiting = await tools.bash({command: "read -r line", timeoutSeconds: 0.1});
      for (const result of [empty, failed, waiting, large]) if (typeof result !== "string") throw Error("Expected readable shell text");
      const observed = await tools.read({path:waiting});
      text({empty, failed, waiting, observed, large});
    `;
      const result = await new PiIntegrationTest({
        testName: "native-shell-result",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["bash", "read", "codemode"],
        environment: { SHELL: "/bin/bash", PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1" },
        conversation: [
          assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [
              toolCall({
                id: "preview",
                name: "bash",
                arguments: {
                  command:
                    'node -e \'for(let i=0;i<2100;i++) console.log("line-"+i+" "+"x".repeat(40))\'',
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Filter shell output inside a native script and show a bounded direct preview.");
      expect(getToolExecution(result, "script").isError).toBe(false);
      const script = getToolExecutionResult(result, "script") as {
        content: { type: string; text?: string }[];
      };
      const output = script.content.find(
        (part) => part.type === "text" && part.text?.startsWith("{"),
      );
      if (output?.text === undefined) throw new Error("Missing shell script JSON output");
      const data = JSON.parse(output.text) as Record<string, string>;
      expect(data.empty).toContain("status: completed");
      expect(data.empty).toContain("exitCode: 0");
      expect(data.empty).toContain("output: (empty)");
      expect(data.failed).toContain("status: failed");
      expect(data.failed).toContain("exitCode: 7");
      expect(data.failed).toContain("bad");
      expect(data.waiting).toContain("status: running");
      expect(data.waiting).toContain("reason: timeout");
      expect(data.waiting).not.toContain("exitCode:");
      expect(data.observed).toContain("status: running");
      expect(data.large).toContain("Earlier output omitted");
      expect(data.large).toContain("TAIL");
      expect(data.large).not.toContain("�");
      expect(Buffer.byteLength(data.large ?? "")).toBeLessThan(50 * 1024);
      const logPath = /^fullOutput: (.+)$/mu.exec(data.large ?? "")?.[1];
      if (!logPath) throw new Error("Missing readable full-log path");
      expect(await readFile(logPath, "utf8")).toBe("HEAD" + "я".repeat(700000) + "TAIL");
      const preview = getToolResultText(result, "preview");
      expect(preview).toContain("Earlier output omitted");
      expect(Buffer.byteLength(preview)).toBeLessThan(50 * 1024);
      const details = getToolExecutionDetails(getToolExecution(result, "preview")) as {
        output: string;
        fullOutputPath: string;
      };
      expect(Buffer.byteLength(details.output)).toBeLessThan(50 * 1024);
      expect(result.tuiRenderedOutput).toContain("line-2099");
      await rm(details.fullOutputPath, { force: true });
      await rm(logPath, { force: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
