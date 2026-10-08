import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      if (!large.includes("Earlier output omitted") || !large.includes("TAIL") || large.includes("�"))
        throw Error("Invalid bounded shell preview");
      const largeBytes = encodeURIComponent(large).replace(/%[A-F\\d]{2}|./gu, "x").length;
      if (largeBytes >= 50 * 1024) throw Error("Shell preview exceeds its byte budget");
      const logPath = /^fullOutput: (.+)$/mu.exec(large)?.[1];
      if (!logPath) throw Error("Missing readable full-log path");
      text("SHELL_RESULTS=" + JSON.stringify({empty, failed, waiting, observed, largeBytes, logPath}));
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
      expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
        false,
      );
      const payload = /^SHELL_RESULTS=(.+)$/mu.exec(getToolResultText(result, "script"))?.[1];
      if (payload === undefined) throw new Error("Missing shell script JSON output");
      const data = JSON.parse(payload) as {
        empty: string;
        failed: string;
        waiting: string;
        observed: string;
        largeBytes: number;
        logPath: string;
      };
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
      expect(data.largeBytes).toBeLessThan(50 * 1024);
      const logPath = data.logPath;
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

test.runIf(process.platform !== "win32")(
  "terminal input receipts stay live resources and cannot authorize file edits",
  async () => {
    const root = path.resolve(".tmp/shell-result");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "input-"));
    try {
      await writeFile(path.join(cwd, "task.txt"), "unchanged\n");
      const code = `
        const opened = await tools.bash({command: "IFS= read -r answer; printf 'resource:%s' \\"$answer\\"", background: true});
        const source = /^session: (shell:[^\\s]+)/m.exec(opened)?.[1];
        if (!source) throw Error("Missing live session");
        try {
          const sent = await tools.write({path: source, content: "hello"});
          await tools.insert({path: source, text: "Enter"});
          const observed = await tools.read({path: sent});
          if (!observed.includes("resource:hello")) throw Error("Input receipt lost its live owner");
          let refused = false;
          try { await tools.replace({path: sent, text: "not a file"}); }
          catch { refused = true; }
          if (!refused) throw Error("Terminal input granted file edit authority");
          text(observed);
        } finally {
          await tools.delete({path: source});
        }
      `;
      const run = await new PiIntegrationTest({
        testName: "native-shell-input-owner",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["bash", "write", "insert", "read", "replace", "delete", "codemode"],
        environment: { SHELL: "/bin/bash", PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1" },
        conversation: [
          assistantMessage([toolCall({ id: "input", name: "codemode", arguments: { code } })]),
          assistantMessage([text("The terminal kept its own resource identity.")]),
        ],
      }).run("Send input and read its live receipt without touching files.");
      expect(getToolExecution(run, "input").isError, getToolResultText(run, "input")).toBe(false);
      expect(getToolResultText(run, "input")).toContain("resource:hello");
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("unchanged\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
