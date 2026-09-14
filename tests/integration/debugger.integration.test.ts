import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("debug creates an addressable configured session without changing source", async () => {
  await withTempWorkspace(async (cwd) => {
    const program = path.join(cwd, "example.py");
    const source = "value = 42\nprint(value)\n";
    await writeFile(program, source);

    const run = await new PiIntegrationTest({
      testName: "debug-session-create",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["debug"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "create-debug-session",
              name: "debug",
              arguments: { adapter: "debugpy", program: "example.py" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create a configured debugger session for example.py");

    const execution = getToolExecution(run, "create-debug-session");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(getToolExecutionDetails(execution)).toMatchObject({
      adapter: "debugpy",
      status: "configured",
      breakpoints: [],
    });
    const details = getToolExecutionDetails(execution) as {
      readonly source?: unknown;
      readonly sourceResource?: unknown;
      readonly breakpointsResource?: unknown;
      readonly program?: unknown;
      readonly cwd?: unknown;
    };
    expect(details.program).toEqual(expect.stringMatching(/\/example\.py$/u));
    expect(details.cwd).toEqual(expect.any(String));
    expect(details.source).toMatch(/^debug:[a-f\d]{12}$/u);
    expect(details.sourceResource).toMatch(/^debug:[a-f\d]{12}\/source$/u);
    expect(details.breakpointsResource).toMatch(/^debug:[a-f\d]{12}\/breakpoints$/u);
    expect(await readFile(program, "utf8")).toBe(source);
  });
});

test("debug accepts every additional adapter through real Pi", async () => {
  await withTempWorkspace(async (cwd) => {
    const adapters = ["elixir", "julia", "r", "ruby", "php", "lua", "shell", "powershell"] as const;
    await Promise.all(
      adapters.map((adapter) => writeFile(path.join(cwd, `example.${adapter}`), "fixture\n")),
    );
    const run = await new PiIntegrationTest({
      testName: "debug-scripting-adapters",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["debug"],
      conversation: [
        assistantMessage(
          adapters.map((adapter) =>
            toolCall({
              id: `create-${adapter}`,
              name: "debug",
              arguments: { adapter, program: `example.${adapter}` },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create configured debugger sessions for the scripting adapter matrix");

    for (const adapter of adapters) {
      const execution = getToolExecution(run, `create-${adapter}`);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
      expect(getToolExecutionDetails(execution)).toMatchObject({ adapter, status: "configured" });
    }
  });
});
