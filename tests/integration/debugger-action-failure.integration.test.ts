import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("a failed debugger start shows the adapter's reason and keeps the session usable", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "app.exe"), "not an executable\n");
    // The VS Code backend refuses an executable without a launch configuration before any launch.
    const code = `
const created = await tools.debug({ backend: "vscode", program: "app.exe" });
const native = await tools.debug({ adapter: "debugpy", program: "missing-module.py" });
const session = /debug:[a-f\\d]{12}/u.exec(String(native))?.[0];
// Failed IDE calls resolve to null; their reasons end the Codemode result.
const started = await tools.insert({ path: session, text: "start" });
const after = await tools.read({ path: session });
await tools.delete({ path: session });
return { created: String(created), started: String(started), after: String(after) };
`;
    await writeFile(path.join(cwd, "missing-module.py"), "import module_that_does_not_exist\n");
    const run = await new PiIntegrationTest({
      testName: "debugger-action-failure",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "insert", "delete", "debug", "codemode", "tool_search"],
      conversation: [
        assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
      // A missing interpreter makes the adapter launch fail inside the start action.
      environment: { PI_PYTHON_PATH: path.join(cwd, "missing-python") },
      timeoutMs: 120_000,
    }).run("Start a debugger session that fails");

    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    const result = getToolResultText(run, "script");
    const failures = codemodeFailures(result);
    expect(result).toContain('"created":"null"');
    expect(result).toContain('"started":"null"');
    // An executable needs a launch configuration; the backend says so instead of launching it as Python.
    expect(failures).toMatch(/- debug app\.exe\n[\s\S]*VS Code backend unavailable/u);
    // The failed start reports the adapter's reason as an error and leaves the session restartable.
    expect(failures).toMatch(
      /- insert debug:[a-f\d]{12}\n[\s\S]*start failed: spawn \S*missing-python ENOENT/u,
    );
    expect(result).toContain("Status: configured");
    expect(result).not.toContain("file operation failed");
    const screen = await readFile(
      path.join(
        testArtifactsDir(import.meta.filename),
        "debugger-action-failure",
        "tui-rendered.log",
      ),
      "utf8",
    );
    expect(screen).toMatch(/✗ spawn \S*missing-python/u);
    expect(screen).not.toContain("file operation failed");
  });
}, 180_000);
