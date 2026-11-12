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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

test.runIf(process.platform !== "win32")(
  "native scripts get shell results in Pi's bash shape without expanding the preview",
  async () => {
    const root = path.resolve(".tmp/shell-result");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      // Keep the wait blocked on stdin until Pi shuts down. Completion delivery has its own test;
      // a short sleep can finish during an existing turn and never request an extra response.
      const code = `
      const empty = await tools.bash({command: "true"});
      // A non-zero exit code is a value, not a failure.
      const failed = await tools.bash({command: "printf bad; exit 7"});
      const large = await tools.bash({command: ${JSON.stringify('node -e \'process.stdout.write("HEAD" + "я".repeat(700000) + "TAIL")\'')}});
      const waiting = await tools.bash({command: "read -r line", timeoutSeconds: 0.1});
      // Only a command that cannot start resolves to null.
      const unstarted = await tools.bash({command: "true", cwd: "ssh://no-such-target/tmp"});
      const observed = await tools.read({path: waiting.session});
      const omitted = /\\n\\n\\[\\.\\.\\. (\\d+) bytes omitted \\.\\.\\.\\]\\n\\n/u.exec(large.output)?.[1];
      text("SHELL_RESULTS=" + JSON.stringify({
        empty, failed, waiting, unstarted, observed,
        large: {
          truncated: large.truncated,
          exit_code: large.exit_code,
          head: large.output.slice(0, 4),
          tail: large.output.slice(-4),
          omitted: Number(omitted),
          bytes: encodeURIComponent(large.output).replace(/%[A-F\\d]{2}|./gu, "x").length,
          replacement: large.output.includes("�"),
          full_output_path: large.full_output_path,
        },
      }));
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
        empty: Record<string, unknown>;
        failed: Record<string, unknown>;
        waiting: Record<string, unknown>;
        unstarted: unknown;
        observed: string;
        large: {
          truncated: boolean;
          exit_code: number;
          head: string;
          tail: string;
          omitted: number;
          bytes: number;
          replacement: boolean;
          full_output_path: string;
        };
      };
      expect(Object.keys(data.empty).sort()).toEqual([
        "exit_code",
        "full_output_path",
        "output",
        "session",
        "truncated",
        "wall_time_seconds",
      ]);
      expect(data.empty).toMatchObject({ output: "", truncated: false, exit_code: 0 });
      expect(typeof data.empty.full_output_path).toBe("string");
      expect(typeof data.empty.wall_time_seconds).toBe("number");
      // A finished command keeps its session address.
      expect(data.empty.session).toMatch(/^shell:[a-f\d]{12}$/u);
      expect(data.failed).toMatchObject({ output: "bad", truncated: false, exit_code: 7 });
      expect(data.unstarted).toBeNull();
      // Only the command that could not start is a failure; it is named by its command line.
      const failed = codemodeFailures(getToolResultText(result, "script"));
      expect(failed).toMatch(/^1 of 6 IDE calls failed:\n- bash true/u);
      expect(failed).toContain("no-such-target");
      expect(failed).not.toContain("exit 7");
      expect(failed).not.toContain("<system-result");
      expect(data.waiting).toMatchObject({ output: "", truncated: false });
      expect(data.waiting.session).toMatch(/^shell:[a-f\d]{12}$/u);
      expect(data.waiting).not.toHaveProperty("exit_code");
      expect(data.observed).toContain("status: running");
      // The log holds 1,400,008 bytes; the value keeps its first and last 512 KiB.
      const marker = "\n\n[... 351432 bytes omitted ...]\n\n";
      expect(data.large).toMatchObject({
        truncated: true,
        exit_code: 0,
        head: "HEAD",
        tail: "TAIL",
        omitted: 1_400_008 - 1024 * 1024,
        bytes: 1024 * 1024 + marker.length,
        replacement: false,
      });
      const logPath = data.large.full_output_path;
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
        const source = opened.session;
        if (!source) throw Error("Missing live session");
        try {
          const sent = await tools.write({path: source, content: "hello"});
          const keys = await tools.insert({path: source, text: "Enter"});
          const observed = await tools.read({path: sent});
          const afterKeys = await tools.read({path: keys});
          if (!afterKeys.includes("resource:hello")) throw Error("Key receipt lost its live owner");
          if (!observed.includes("resource:hello")) throw Error("Input receipt lost its live owner");
          const refused = (await tools.replace({path: sent, text: "not a file"})) === null;
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
