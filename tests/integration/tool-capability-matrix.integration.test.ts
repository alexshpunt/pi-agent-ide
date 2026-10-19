import { readFile, writeFile } from "node:fs/promises";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { capabilityCases } from "#capabilities/cases.ts";

test("the capability validator checks Search facts and unchanged result provenance", async () => {
  await withTempWorkspace(async (cwd) => {
    const task = capabilityCases.find((candidate) => candidate.id === "search-script-facts");
    const contents = task?.files?.["task.txt"];
    const scope = task?.files?.["scope.ts"];
    if (!task || contents === undefined || scope === undefined)
      throw Error("Missing Search facts case");
    await writeFile(path.join(cwd, "task.txt"), contents);
    await writeFile(path.join(cwd, "scope.ts"), scope);
    const run = await new PiIntegrationTest({
      testName: "capability-search-facts",
      transport: "rpc",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "facts",
              name: "codemode",
              arguments: {
                code: `const empty = await tools.search({path:"task.txt",query:"regex:^ABSENT$"});
if (empty.hasMatches !== false || empty.complete !== true) throw Error("Empty facts missing");
const limited = await tools.search({path:"scope.ts",query:"ast:probe($ARG)",limit:1});
if (limited.hasMatches !== true || limited.complete !== false) throw Error("Incomplete facts missing");
let failed = false;
try { await tools.search({path:"task.txt",query:"regex:("}); } catch { failed = true; }
if (!failed) throw Error("Invalid Search did not reject");
const found = await tools.search({path:"task.txt",query:"OLD",limit:1000});
if (found.hasMatches !== true || found.complete !== true || typeof found.result !== "string") throw Error("Complete facts missing");
await tools.replace({path:found.result,text:"NEW"});
text("Search facts verified");`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(task.prompt ?? "Check structured Search facts");
    expect(getToolExecution(run, "facts").isError, getToolResultText(run, "facts")).toBe(false);
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(task.expected?.["task.txt"]);
    expect(await readFile(path.join(cwd, "scope.ts"), "utf8")).toBe(task.expected?.["scope.ts"]);
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
    const missingFacts = events.map((event) =>
      event.type === "tool_execution_end" && event.toolName === "search"
        ? { ...event, result: { content: event.result?.content } }
        : event,
    );
    expect(validateRoute(task, missingFacts, "codemode").passed).toBe(false);
    const bypass = events.map((event) =>
      event.type === "tool_execution_start" && event.toolName === "replace"
        ? { ...event, args: { path: "task.txt", text: "NEW" } }
        : event,
    );
    expect(validateRoute(task, bypass, "codemode").passed).toBe(false);
  });
});

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
                code: 'const source = await tools.read({path:"task.txt"}); const matches = await tools.search({path:source,query:"OLD"}).then(value => value.result); text(await tools.replace({path:matches,text:"NEW"}));',
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
