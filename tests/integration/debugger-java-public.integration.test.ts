import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";
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

const execute = promisify(execFile);
const enabled = process.env.PI_DEBUGGER_JVM_LANGUAGE === "java";
const sourceText =
  "public class Main {\n  public static void main(String[] args) {\n    int subtotal = 12 + 30;\n    int result = subtotal + 1;\n    System.out.println(result);\n  }\n}\n";

function call(id: string, name: string, arguments_: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: arguments_ })], {
    stopReason: "toolUse",
  });
}

// Quarantined on Windows: public-Pi Java startup flakes while native lifecycle cases pass.
// Evidence: https://github.com/alexshpunt/pi-agent-ide/actions/runs/37105857611
// Evidence: https://github.com/alexshpunt/pi-agent-ide/actions/runs/37108400575
// Keep Linux public-Pi coverage and native Windows Java tests enabled.
test.runIf(enabled && process.platform !== "win32")(
  "public Pi Java calls stop with source and locals then terminate from a spaced path",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi public Java lifecycle "));
    try {
      const source = path.join(cwd, "src/main/java/Main.java");
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(path.join(cwd, "build/classes/java/main"), { recursive: true });
      await writeFile(source, sourceText);
      await execute(
        process.env.PI_JAVAC_PATH ?? "javac",
        ["-g", "-d", "build/classes/java/main", "src/main/java/Main.java"],
        { cwd },
      );
      const run = await new PiIntegrationTest({
        testName: `java-public-lifecycle-${process.env.PI_AGENT_IDE_TEST_INSTALLATION ? "installed-" : ""}${process.platform}`,
        rawMode: false,
        isolateUserResources: true,
        tuiSize: { cols: 120, rows: 40 },
        // Leave time for the harness to save failure evidence before Vitest's 30s deadline.
        timeoutMs: 25_000,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve(
            process.env.PI_AGENT_IDE_TEST_INSTALLATION
              ? path.join(process.env.PI_AGENT_IDE_TEST_INSTALLATION, "java-public-fixture.mjs")
              : "tests/integration/support/java-public-fixture.ts",
          ),
          path.resolve(
            process.env.PI_AGENT_IDE_TEST_INSTALLATION
              ? path.join(process.env.PI_AGENT_IDE_TEST_INSTALLATION, "node_modules/pi-agent-ide")
              : "src/pi-agent-ide.ts",
          ),
        ],
        tools: ["check_java_lifecycle", "debug", "read", "insert", "delete"],
        // Pi helper downloads are not part of the Java lifecycle contract.
        environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "0", PI_OFFLINE: "1" },
        conversation: [
          call("guide", "read", { path: "docs:debugger" }),
          call("start", "check_java_lifecycle", { phase: "start" }),
          call("continue", "check_java_lifecycle", { phase: "continue" }),
          assistantMessage([text("Java lifecycle complete.")]),
        ],
      }).run("Debug Main.java at line 4, inspect subtotal, then continue and clean up.");
      for (const id of [
        "guide",
        "start",
        "continue",
        "start/1",
        "start/2",
        "start/3",
        "start/4",
        "start/5",
        "start/6",
        "continue/1",
        "continue/2",
        "continue/3",
      ]) {
        const execution = getToolExecution(run, id);
        expect(execution.isError, JSON.stringify(execution)).toBe(false);
      }
      const stopped = getToolExecutionDetails(getToolExecution(run, "start")) as {
        metadata?: { semanticAction?: { snapshot?: unknown } };
      };
      expect(stopped.metadata?.semanticAction?.snapshot).toMatchObject({
        status: "stopped",
        stop: {
          frame: { line: 4, source: { path: source } },
          variables: expect.arrayContaining([
            expect.objectContaining({ name: "subtotal", value: "42" }),
          ]) as unknown,
        },
      });
      expect(getToolResultText(run, "start")).toContain("Status: stopped");
      expect(getToolResultText(run, "start")).toContain("subtotal: 42");
      expect(getToolResultText(run, "continue")).toContain("Status: terminated");
      expect(run.tuiRenderedOutput).toContain("Main.java");
      // Native Windows retains the final viewport, not Linux-style scrollback.
      const renderedStream = stripVTControlCharacters(run.terminalOutput);
      expect(renderedStream).not.toContain("not found. Downloading...");
      expect(renderedStream).toContain("Status: stopped");
      expect(renderedStream).toContain("subtotal: 42");
      expect(run.tuiRenderedOutput).toContain("Status: terminated");
      // The harness force-closes ConPTY after settling; its Windows exit code is not Pi failure.
      expect(run.state?.mode).toBe("tui");
      expect(run.state?.isIdle).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
