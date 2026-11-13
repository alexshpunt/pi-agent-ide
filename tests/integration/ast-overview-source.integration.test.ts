import { mkdir, readFile, writeFile } from "node:fs/promises";
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
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage(
    [toolCall({ id, name, arguments: args, chunks: { kind: "fixed", size: 4096 }, delayMs: 0 })],
    { stopReason: "toolUse" },
  );

test.each([
  { name: "lines", rows: 2100, padding: "  consume(value);" },
  { name: "bytes", rows: 1000, padding: `  consume("${"界".repeat(30)}");` },
])(
  "Search uses the original Read window behind direct overviews and exact Codemode text ($name)",
  async ({ name, rows, padding }) => {
    await withTempWorkspace(async (cwd) => {
      const source = [
        'function outsideBefore() { return "NEEDLE"; }',
        "function checkout() {",
        ...Array<string>(100).fill(padding),
        '  consume("NEEDLE");',
        ...Array<string>(rows - 100).fill(padding),
        "}",
        'function outsideAfter() { return "NEEDLE"; }',
        "",
      ].join("\n");
      await writeFile(path.join(cwd, "large.ts"), source);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true, noPostProcessing: true }),
      );
      const run = await new PiIntegrationTest({
        testName: `overview-source-${name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("tests/integration/fixtures/forward-text-result.ts"),
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
        ],
        tools: ["read", "search", "replace", "write", "codemode"],
        conversation: [
          call("full", "read", { path: "large.ts" }),
          call("direct-result", "search", { path: "$previous-result", query: "NEEDLE" }),
          call("window", "read", { path: "large.ts", offset: 2, limit: rows + 3 }),
          call("direct-uuid", "search", { path: "$previous-uuid", query: "NEEDLE" }),
          call("save", "codemode", {
            code: String.raw`
const full = await tools.read({path:"large.ts"});
if (full.text.includes("Some source text is omitted.") || !full.text.includes('consume("NEEDLE")')) throw Error("Expected the exact source text");
for (const input of [full, full.id]) {
  const found = await tools.search({path:input,query:"NEEDLE"}).then(value => value.result);
  if (!found.includes("3 matches in 1 file") || !found.includes("large.ts:103:12-18")) throw Error(found);
}
const window = await tools.read({path:"large.ts",offset:2,limit:${rows + 3}});
if (window.text.includes("outsideBefore") || !window.text.includes('consume("NEEDLE")')) throw Error("Expected the exact window text");
store("largeWindow",window);
text("Exact sources saved");
`,
          }),
          call("reuse", "codemode", {
            code: String.raw`
const window = load("largeWindow");
for (const input of [window, window.id]) {
  const found = await tools.search({path:input,query:"NEEDLE"}).then(value => value.result);
  if (!found.includes("1 match in 1 file") || !found.includes("large.ts:103:12-18")) throw Error(found);
  for (const query of ["outsideBefore","outsideAfter","regex:Code overview|scope-begin|Some source text|requested text|…"]) {
    const empty = await tools.search({path:input,query}).then(value => value.result);
    if (!empty.includes("No matches found")) throw Error(empty);
    await tools.replace({path:empty,text:"BAD"});
  }
}
const bounded = await tools.read({path:window,offset:102,limit:1});
if (!(await tools.search({path:bounded,query:"NEEDLE"}).then(value => value.result)).includes("large.ts:103:12-18")) throw Error("Bounded Read lost its exact source position");
const small = await tools.read({path:"large.ts",offset:103,limit:1});
if (!(await tools.search({path:small,query:"NEEDLE"}).then(value => value.result)).includes("large.ts:103:12-18")) throw Error("Small Read composition regressed");
const selected = await tools.search({path:window,query:"NEEDLE"}).then(value => value.result);
await tools.replace({path:selected,text:"FOUND"});
text("Only the original window was searched and edited");
`,
          }),
          call("stale", "codemode", {
            code: String.raw`
const window = load("largeWindow");
for (const input of [window, window.id]) {
  // An exact window follows its region into the edited file instead of its old text.
  const found = await tools.search({path:input,query:"NEEDLE"}).then(value => value.result);
  if (!found.includes("large.ts:2-${rows + 4}") || !found.includes("No matches found")) throw Error(found);
}
text("Old window inputs searched the current region");
`,
          }),
          assistantMessage([text("Done")]),
        ],
      }).run("Search the source behind Read results without widening the original window");
      for (const id of ["full", "direct-result", "window", "direct-uuid", "save", "reuse", "stale"])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      for (const id of ["full", "window"])
        expect(getToolExecutionDetails(getToolExecution(run, id))).toMatchObject({
          resolvedBy: "ast-overflow",
        });
      expect(getToolResultText(run, "direct-result")).toContain("3 matches in 1 file");
      expect(getToolResultText(run, "direct-uuid")).toContain("1 match in 1 file");
      expect(getToolResultText(run, "direct-uuid")).toContain("large.ts:103:12-18");
      const events = run.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      // Overview cases are direct-only; the Codemode route stores the exact large window.
      const caseIds = name === "lines" ? ["read-large-store"] : [];
      for (const caseId of caseIds) {
        const task = capabilityCases.find((candidate) => candidate.id === caseId);
        if (task === undefined) throw Error("Missing large-read capability case");
        expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
        const bypass = events.map((event) =>
          event.type === "tool_execution_start" && event.toolName === "search"
            ? { ...event, args: { ...event.args, path: "large.ts" } }
            : event,
        );
        expect(validateRoute(task, bypass, "codemode").passed).toBe(false);
      }
      expect(await readFile(path.join(cwd, "large.ts"), "utf8")).toBe(
        source.replace('consume("NEEDLE")', 'consume("FOUND")'),
      );
    });
  },
  120_000,
);
