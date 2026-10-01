import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

test.runIf(process.platform !== "win32")(
  "native scripts filter structured shell output without expanding the preview",
  async () => {
    const root = path.resolve(".tmp/shell-result");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      const code = `
      const empty = await tools.bash({command: "true"});
      const failed = await tools.bash({command: "printf bad; exit 7"});
      const large = await tools.bash({command: ${JSON.stringify('node -e \'process.stdout.write("HEAD" + "я".repeat(700000) + "TAIL")\'')}});
      const waiting = await tools.bash({command: "sleep 0.3; printf done", timeoutSeconds: 0.1});
      text({empty, failed, waiting, large: {...large, output: undefined, bytes: large.output.length * 2 - 8, head: large.output.slice(0,4), tail: large.output.slice(-4), broken: large.output.includes("�")}});
    `;
      const result = await new PiIntegrationTest({
        testName: "native-shell-result",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["bash", "codemode"],
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
          assistantMessage([text("Background completed")]),
        ],
      }).run("Filter shell output inside a native script and show a bounded direct preview.");
      expect(getToolExecution(result, "script").isError).toBe(false);
      const data = JSON.parse(getToolResultText(result, "script").split("Output:\n")[1] ?? "") as {
        empty: { full_output_path: string };
        failed: { full_output_path: string };
        waiting: { full_output_path: string };
        large: {
          full_output_path: string;
          bytes: number;
          output_ranges: { start: number; end: number }[];
        };
      };
      expect(data.empty).toMatchObject({
        output: "",
        truncated: false,
        exit_code: 0,
        status: "completed",
      });
      expect(data.failed).toMatchObject({ output: "bad", exit_code: 7, status: "failed" });
      expect(data.waiting).toMatchObject({
        status: "running",
        background: true,
        wait_reason: "timeout",
      });
      expect(data.waiting).not.toHaveProperty("exit_code");
      expect(data.large).toMatchObject({
        truncated: true,
        head: "HEAD",
        tail: "TAIL",
        broken: false,
      });
      expect(data.large.bytes).toBeLessThanOrEqual(1024 * 1024);
      const log = await readFile(data.large.full_output_path, "utf8");
      expect(log).toBe("HEAD" + "я".repeat(700000) + "TAIL");
      const ranges = data.large.output_ranges;
      expect(ranges).toHaveLength(2);
      expect(ranges[0]?.start).toBe(0);
      expect(ranges[1]?.end).toBe(Buffer.byteLength(log));
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
      for (const item of [data.empty, data.failed, data.waiting, data.large])
        await rm(item.full_output_path, { force: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
