import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { capabilityCases } from "#capabilities/cases.ts";

test("the AST boundary case produces usable scope anchors from its fixture", async () => {
  await withTempWorkspace(async (cwd) => {
    const task = capabilityCases.find((candidate) => candidate.id === "read-ast-boundary");
    const contents = task?.files?.["task.ts"];
    if (!task || !contents) throw Error("Missing AST boundary case");
    await writeFile(path.join(cwd, "task.ts"), contents);
    const run = await new PiIntegrationTest({
      testName: "capability-ast-boundary-evidence",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "codemode",
              arguments: {
                code: 'const source = await tools.read({path:"task.ts", views:["ast"]}); const start = source.match(/scope-begin-[A-F0-9]+/)[0]; const end = source.match(/scope-end-[A-F0-9]+/)[0]; text(await tools.replace({path:"task.ts", start, end, text:"function renamed() { return 8; }"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(task.prompt ?? "Check AST scope anchors");
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
    expect(await readFile(path.join(cwd, "task.ts"), "utf8")).toBe(task.expected?.["task.ts"]);
  });
});
test("the capability validator follows real nested tool results instead of names alone", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
    const task = capabilityCases.find((candidate) => candidate.id === "read-search-replace");
    if (!task) throw Error("Missing composition case");
    const run = await new PiIntegrationTest({
      testName: "capability-composition-evidence",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "codemode",
              arguments: {
                code: 'const source = await tools.read({path:"task.txt"}); const matches = await tools.search({path:source,query:"OLD"}); text(await tools.replace({path:matches,text:"NEW"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(task.prompt ?? "Check result composition");
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
    const bypass = events.map((event) =>
      event.type === "tool_execution_start" && event.toolName === "search"
        ? { ...event, args: { ...event.args, path: "task.txt" } }
        : event,
    );
    expect(validateRoute(task, bypass, "codemode").passed).toBe(false);
  });
});
