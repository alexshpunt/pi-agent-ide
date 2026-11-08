import {
  DETACHED_COUNT,
  detachedEnd,
  detachedMarker,
  detachedName,
  extraEnd,
  extraMarker,
  unitEnd,
  unitMarker,
  unitName,
  unitStepLine,
  type LanguageSpec,
} from "./languages.ts";
import { CYCLE_END_SUFFIX } from "./probe-extension.ts";

/** One scripted tool call and the check of its result text. */
export interface Step {
  readonly id: string;
  readonly cycle: number;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The step expects the tool to refuse the call. */
  readonly expectsError?: boolean;
  /**
   * A result that says a checker is still pending is recorded instead of failing: a cold start
   * (rust-analyzer loading, the first clippy build) can take longer than a diagnostics read waits.
   */
  readonly allowsPending?: boolean;
  /** Returns a problem description, or undefined when the result is as expected. */
  check(result: string): string | undefined;
}

export interface AgentFiles {
  readonly agent: string;
  /** Main source file, relative to the project root. */
  readonly file: string;
  /** Scratch file in the same project. */
  readonly scratch: string;
  readonly unitCount: number;
  readonly sizeBytes: number;
  /** One-based line of each unit marker in the generated file. */
  readonly unitLines: readonly number[];
}

/** Pi Agent IDE refuses AST outlines of larger files with a clear message. */
const AST_OUTLINE_LIMIT_BYTES = 262_144;

/** Lines a unit may move by after earlier cycles; reads start this far before the marker. */
const LINE_SLACK = 12;

/** Builds the deterministic step sequence of one agent. */
export function buildSteps(spec: LanguageSpec, files: AgentFiles, cycles: number): Step[] {
  const steps: Step[] = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    steps.push(...cycleSteps(spec, files, cycle));
  }
  return steps;
}

function cycleSteps(spec: LanguageSpec, files: AgentFiles, cycle: number): Step[] {
  const { agent, file, scratch } = files;
  const agentNumber = Number.parseInt(agent.replace(/\D/g, ""), 10) || 0;
  const base = 1 + ((cycle * 7919 + agentNumber * 131) % (files.unitCount - 48));
  const unit = base;
  const insertAfter = base + 10;
  const symbolUnit = base + 20;
  const codemodeUnit = base + 30;
  const detached = (cycle + agentNumber) % DETACHED_COUNT;
  const copied = (detached + 1) % DETACHED_COUNT;
  const name = unitName(agent, unit);
  const stepLine = unitStepLine(agent, unit);
  const prefix = `c${cycle}`;
  const step = (
    label: string,
    tool: string,
    args: Record<string, unknown>,
    check: (result: string) => string | undefined,
  ): Step => ({ id: `${prefix}-${label}`, cycle, tool, arguments: args, check });

  return [
    step(
      "read-anchors",
      "read",
      { path: file, offset: lineOf(files, unit), limit: 60, views: ["anchors"] },
      (result) =>
        expectAll(result, [`|${unitMarker(spec, agent, unit)}`]) ??
        (/\d+#[0-9A-F]{4}\|/.test(result) ? undefined : "no LINE#HASH anchors"),
    ),
    {
      ...step("read-outline", "read", { path: `ast:${file}`, limit: 40 }, (result) =>
        files.sizeBytes > AST_OUTLINE_LIMIT_BYTES
          ? expectAll(result, ["AST outline limit"])
          : expectAll(result, [unitName(agent, 0), "scope-begin-"]),
      ),
      expectsError: files.sizeBytes > AST_OUTLINE_LIMIT_BYTES,
    },
    step("search-file", "search", { query: `"${name}"`, path: file }, (result) =>
      expectAll(result, ["2 matches in 1 file"]),
    ),
    step(
      "search-project",
      "search",
      { query: `"${stepLine}"`, path: "src", include: `*.${spec.extension}` },
      (result) => expectAll(result, ["1 match in 1 file", file]),
    ),
    step(
      "replace-text",
      "replace",
      { path: file, start: stepLine, text: `${stepLine} + ${cycle}` },
      (result) => expectAll(result, ["Replaced selected text", `${stepLine} + ${cycle}`]),
    ),
    step(
      "insert-function",
      "insert",
      {
        path: file,
        anchor: unitEnd(spec, agent, insertAfter),
        text: spec.extraFunction(agent, cycle).trimEnd(),
      },
      (result) => expectAll(result, ["Inserted new text", extraMarker(spec, agent, cycle)]),
    ),
    step(
      "insert-error",
      "insert",
      {
        path: file,
        anchor: unitEnd(spec, agent, insertAfter + 1),
        text: spec.brokenLine(agent, cycle),
      },
      (result) => expectAll(result, ["Inserted new text", spec.brokenLine(agent, cycle)]),
    ),
    {
      ...step("read-diagnostics", "read", { path: `diagnostics:${file}` }, (result) =>
        expectErrorOn(result, spec.brokenLine(agent, cycle)),
      ),
      allowsPending: cycle === 1,
    },
    step("delete-error", "delete", { path: file, start: spec.brokenLine(agent, cycle) }, (result) =>
      expectAll(result, ["Deleted selected text"]),
    ),
    step(
      "delete-function",
      "delete",
      { path: file, start: extraMarker(spec, agent, cycle), end: extraEnd(spec, agent, cycle) },
      (result) => expectAll(result, ["Deleted selected text"]),
    ),
    step(
      "write-scratch",
      "write",
      { path: scratch, content: `${spec.scratchHeader(agent, cycle)}\n` },
      (result) => expectAll(result, ["Saved file"]),
    ),
    step(
      "move-symbol-out",
      "move",
      {
        path: `symbol:${file}#${detachedName(agent, detached)}`,
        target: scratch,
        targetStart: "end",
      },
      (result) => expectAll(result, ["Moved selected text", detachedName(agent, detached)]),
    ),
    step(
      "move-symbol-back",
      "move",
      {
        path: `symbol:${scratch}#${detachedName(agent, detached)}`,
        target: file,
        targetStart: detachedMarker(spec, agent, detached),
      },
      (result) => expectAll(result, ["Moved selected text", detachedName(agent, detached)]),
    ),
    step(
      "copy-text",
      "copy",
      {
        path: file,
        start: detachedMarker(spec, agent, copied),
        end: detachedEnd(spec, agent, copied),
        target: scratch,
        targetStart: "end",
      },
      (result) => expectAll(result, ["Copied selected text", detachedName(agent, copied)]),
    ),
    step(
      "ast-search",
      "ast_search",
      { pattern: `${name}($A)`, path: file, language: spec.astLanguage, limit: 10 },
      (result) => expectAll(result, [":1:match"]) ?? expectNone(result, [":2:match"]),
    ),
    step("lsp-symbol", "lsp_search", { query: name, path: file }, (result) =>
      expectAll(result, [`definition ${name}`]),
    ),
    step("lsp-declaration", "lsp_search", { declaration: `${file}#${name}` }, (result) =>
      expectAll(result, [`declaration ${file}#${name}`, stepLine]),
    ),
    step("lsp-calls", "lsp_search", { calls: `${file}#${name}` }, (result) =>
      expectAll(result, [`## graph: ${name}`, "Incoming calls: 1"]),
    ),
    step(
      "replace-symbol",
      "replace",
      {
        path: `symbol:${file}#${unitName(agent, symbolUnit)}`,
        text: functionText(spec, agent, symbolUnit, cycle),
      },
      (result) => expectAll(result, ["Replaced selected text", `total + ${cycle} + `]),
    ),
    step(
      "codemode-batch",
      "codemode",
      { code: codemodeBatch(spec, files, codemodeUnit, cycle) },
      (result) => expectAll(result, ["codemode batch ok"]),
    ),
    step(
      `final-search${CYCLE_END_SUFFIX}`,
      "search",
      { query: `regex:(extra|broken)_${agent}_|BROKEN_${agent.toUpperCase()}_`, path: file },
      (result) =>
        /\bmatch(es)? in \d+ file/.test(result) ? "temporary code is still in the file" : undefined,
    ),
  ];
}

/** The function of a unit without its marker lines, as a symbol replacement. */
function functionText(spec: LanguageSpec, agent: string, index: number, variant: number): string {
  const lines = spec.unitFunction(agent, index, variant).trimEnd().split("\n");
  return lines.slice(1, -1).join("\n");
}

/**
 * Codemode reuses a returned anchor: read lines with anchors, replace one by its anchor, then
 * search, ast_search and read diagnostics in parallel and check every result in the script.
 */
function codemodeBatch(
  spec: LanguageSpec,
  files: AgentFiles,
  index: number,
  cycle: number,
): string {
  const stepLine = unitStepLine(files.agent, index);
  const name = unitName(files.agent, index);
  return `const file = ${JSON.stringify(files.file)};
const stepLine = ${JSON.stringify(stepLine)};
const page = String(await tools.read({ path: file, offset: ${lineOf(files, index)}, limit: 60, views: ["anchors"] }));
const line = page.split("\\n").find((candidate) => candidate.includes(stepLine));
const match = line && /^\\s*(\\d+#[0-9A-F]{4})\\|(.*)$/.exec(line);
if (!match) throw new Error("no anchored line with " + stepLine);
await tools.replace({ path: file, start: match[1], text: match[2].replace(stepLine, stepLine + " + ${cycle}") });
const [found, calls, diagnostics] = await Promise.all([
  tools.search({ query: JSON.stringify(stepLine + " + ${cycle}"), path: file }),
  tools.ast_search({ pattern: ${JSON.stringify(`${name}($A)`)}, path: file, language: ${JSON.stringify(spec.astLanguage)} }),
  tools.read({ path: "diagnostics:" + file }),
]);
if (!String(found.result).includes("1 match in 1 file")) throw new Error("search after replace: " + found.result);
if (!calls.hasMatches) throw new Error("ast_search found no call of ${name}");
if (String(diagnostics).includes("[ERROR]")) throw new Error("unexpected diagnostics: " + diagnostics);
text("codemode batch ok");`;
}

function lineOf(files: AgentFiles, index: number): number {
  return Math.max(1, (files.unitLines[index] ?? 1) - LINE_SLACK);
}

function expectAll(result: string, needles: readonly string[]): string | undefined {
  const missing = needles.filter((needle) => !result.includes(needle));
  return missing.length === 0
    ? undefined
    : `missing ${missing.map((needle) => JSON.stringify(needle)).join(", ")}`;
}

function expectNone(result: string, needles: readonly string[]): string | undefined {
  const present = needles.filter((needle) => result.includes(needle));
  return present.length === 0
    ? undefined
    : `unexpected ${present.map((needle) => JSON.stringify(needle)).join(", ")}`;
}

function expectErrorOn(result: string, line: string): string | undefined {
  const reported = result
    .split("\n")
    .find((candidate) => candidate.startsWith(line) || candidate.includes(`${line}  <!--`));
  if (reported?.includes("[ERROR]")) return undefined;
  const status = result
    .split("\n")
    .find((candidate) => /^(lsp|[\w-]+): /.test(candidate.replace(/^<system-result.*$/, "")));
  return `no error reported on the inserted line${status === undefined ? "" : ` (${status.trim()})`}`;
}
