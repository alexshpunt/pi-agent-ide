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
import { parseEvents, validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { capabilityCases } from "#capabilities/cases.ts";

test.each(["direct", "codemode"] as const)(
  "the capability validator preserves declared provider failures (%s)",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      const task = capabilityCases.find((candidate) => candidate.id === `read-error-${mode}`);
      if (!task?.expected) throw Error("Missing provider failure case");
      await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
      const requests = ["absent.txt", "fixture:read-provider#metadata", "task.txt"];
      const conversation =
        mode === "direct"
          ? requests.map((source, index) =>
              assistantMessage(
                [toolCall({ id: `read-${index}`, name: "read", arguments: { path: source } })],
                { stopReason: "toolUse" },
              ),
            )
          : [
              assistantMessage(
                [
                  toolCall({
                    id: "read-errors",
                    name: "codemode",
                    arguments: {
                      code: `for (const path of ${JSON.stringify(requests)}) {
  const result = await tools.read({ path });
  text(result);
}`,
                    },
                  }),
                ],
                { stopReason: "toolUse" },
              ),
            ];
      const run = await new PiIntegrationTest({
        testName: `capability-provider-failure-${mode}`,
        transport: "rpc",
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("benchmarks/tool-capabilities/semantic-write-fixture.ts"),
        ],
        tools: ["read", "codemode"],
        conversation: [...conversation, assistantMessage([text("keep")])],
      }).run(task.prompt ?? "Check provider error ownership");
      for (const [file, expected] of Object.entries(task.expected))
        expect(await readFile(path.join(cwd, file), "utf8")).toBe(expected);
      const events = run.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      expect(validateRoute(task, events, mode)).toEqual({ passed: true, reasons: [] });
      if (mode === "codemode")
        expect(
          getToolExecution(run, "read-errors").isError,
          getToolResultText(run, "read-errors"),
        ).toBe(false);
    });
  },
);
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
      tools: ["search", "ast_search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "facts",
              name: "codemode",
              arguments: {
                code: `const empty = await tools.search({path:"task.txt",query:"regex:^ABSENT$"});
if (empty.hasMatches !== false || empty.complete !== true) throw Error("Empty facts missing");
const limited = await tools.ast_search({path:"scope.ts",pattern:"probe($ARG)",limit:1});
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

test("the native TUI public event mirror is usable by the unchanged capability validator", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
    const task = capabilityCases.find((candidate) => candidate.id === "read-search-replace");
    if (!task) throw Error("Missing composition case");
    const run = await new PiIntegrationTest({
      testName: "capability-native-tui-mirror",
      artifactsDir: testArtifactsDir(import.meta.filename),
      timeoutMs: 120_000,
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/capability-tui-mirror.ts"),
      ],
      tools: ["read", "search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "mirror-compose",
              name: "codemode",
              arguments: {
                code: 'const source = await tools.read({path:"task.txt"}); const matches = await tools.search({path:source,query:"OLD"}); text(await tools.replace({path:matches.result,text:"NEW"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compose native tools while retaining public TUI execution evidence");
    const events = parseEvents(await readFile(path.join(cwd, "public-events.jsonl"), "utf8"));
    expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
    expect(events.some((event) => event.type === "agent_settled")).toBe(true);
    expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
    expect(run.tuiRenderedOutput).toContain("task.txt");
  });
});
test("the real provider registry rejects refresh before its transport can run", async () => {
  await withTempWorkspace(async (cwd) => {
    await new PiIntegrationTest({
      testName: "capability-no-refresh-registry",
      artifactsDir: testArtifactsDir(import.meta.filename),
      timeoutMs: 120_000,
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("tests/integration/fixtures/capability-auth-probe.ts")],
      tools: ["capability_auth_probe"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "guard-probe", name: "capability_auth_probe", arguments: {} })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Check the no-refresh registry using synthetic arguments, without resolving credentials",
    );
    expect(
      JSON.parse(await readFile(path.join(cwd, "guard-result.json"), "utf8")) as unknown,
    ).toEqual({
      installed: true,
      refused: true,
      originalUnchanged: true,
    });
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
      timeoutMs: 120_000,
      cwd,
      isolateUserResources: true,
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
test("the capability validator preserves real IDE provenance through a transparent MCP alias", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
    const task = capabilityCases.find((candidate) => candidate.id === "read-search-replace");
    if (!task) throw Error("Missing composition case");
    const run = await new PiIntegrationTest({
      testName: "capability-alias-provenance",
      artifactsDir: testArtifactsDir(import.meta.filename),
      timeoutMs: 120_000,
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/capability-alias.ts"),
      ],
      tools: ["read", "search", "replace", "codemode", "mcp__fixture__read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compose-alias",
              name: "codemode",
              arguments: {
                code: 'const source = await tools.mcp__fixture__read({path:"task.txt"}); const matches = await tools.search({path:source,query:"OLD"}); text(await tools.replace({path:matches.result,text:"NEW"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compose unchanged results through the Read alias and native Search and Replace");
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
    expect(
      events.some(
        (event) => event.type === "tool_execution_start" && event.toolName === "mcp__fixture__read",
      ),
    ).toBe(true);
    expect(validateRoute(task, events, "codemode").passed).toBe(false);
    expect(validateRoute(task, events, "codemode", { mcp__fixture__read: "read" })).toEqual({
      passed: true,
      reasons: [],
    });
    const bypass = events.map((event) =>
      event.type === "tool_execution_start" && event.toolName === "search"
        ? { ...event, args: { ...event.args, path: "task.txt" } }
        : event,
    );
    expect(validateRoute(task, bypass, "codemode", { mcp__fixture__read: "read" }).passed).toBe(
      false,
    );
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
      timeoutMs: 120_000,
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "codemode",
              arguments: {
                code: 'const source = await tools.read({path:"task.txt"}); const matches = await tools.search({path:source,query:"OLD"}); text(await tools.replace({path:matches.result,text:"NEW"}));',
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
