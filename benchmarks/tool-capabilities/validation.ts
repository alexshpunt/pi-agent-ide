import path from "node:path";

/** A retained JSON-mode event; unknown records remain in the evidence. */
export interface RunEvent {
  type: string;
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: { content?: { type: string; text?: string }[] };
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string; text?: string }[];
    model?: string;
    provider?: string;
  };
}

/** A source argument must carry a reference returned by an earlier real execution. */
export interface ResultReuse {
  from: number;
  field: string | string[];
  kind?: string;
  newParent?: boolean;
}

function fieldValue(value: unknown, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      value,
    );
}
/** One actual execution required to establish a capability. */
export interface RouteStep {
  tool: string;
  /** At least one reviewed argument variant must match, in addition to args. */
  argsAny?: Record<string, unknown>[];
  args?: Record<string, unknown>;
  contains?: string;
  /** A nested call must not copy this text into its completed Codemode parent's output. */
  parentExcludes?: string;
  image?: boolean;
  /** Native text calls can be accepted before their parent reports a write failure. */
  error?: boolean | "direct";
  reuse?: ResultReuse | ResultReuse[];
}

/** An executable task may protect several related capabilities. */
export interface CapabilityCase {
  id: string;
  capabilities: string[];
  modes: string[];
  steps: RouteStep[];
  prompt?: string;
  files?: Record<string, string>;
  expected?: Record<string, string | null>;
  answer?: string;
  prerequisite?: string;
  setup?: string;
  git?: boolean;
}

/** A durable capability and its executable checks. */
export interface Capability {
  id: string;
  cases: string[];
}

/** Parse Pi's JSONL framing without treating Unicode separators as new records. */
export function parseEvents(output: string): RunEvent[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunEvent);
}

/** Return the text actually delivered by a completed tool. */
export function resultText(event: RunEvent): string {
  return (event.result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function fixturePath(value: string): string {
  if (/^https?:/.test(value)) return new URL(value).href;
  const prefix = value.startsWith("raw:") ? "raw:" : "";
  const source = value.slice(prefix.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file://")) return value;
  const absolute = source.startsWith("file://") ? new URL(source).pathname : source;
  const resolved = path.posix.resolve("/workspace/fixture", absolute);
  return prefix + path.posix.relative("/workspace/fixture", resolved);
}

function matches(expected: unknown, actual: unknown, field = ""): boolean {
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      (expected as unknown[]).every((value, i) => matches(value, (actual as unknown[])[i]))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        matches(value, (actual as Record<string, unknown>)[key], key),
      )
    );
  if (
    ["path", "file", "target"].includes(field) &&
    typeof expected === "string" &&
    typeof actual === "string"
  )
    return fixturePath(expected) === fixturePath(actual);
  if (
    field === "query" &&
    typeof expected === "string" &&
    typeof actual === "string" &&
    !/^(?:regex|ast|symbols|process|files):|\b(?:AND|OR|NOT)\b/.test(expected)
  )
    return expected === actual.replace(/^"([\s\S]*)"$/, "$1");
  return expected === actual;
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return (value as unknown[]).flatMap(values);
  return typeof value === "string" ? [value] : [];
}

function reuses(value: unknown, output: string, kind = "result"): boolean {
  const ids =
    kind === "result"
      ? [
          ...[...output.matchAll(/<uuid>([a-f0-9-]+)<\/uuid>/gi)].map((match) => match[1] ?? ""),
          ...[
            ...output.matchAll(/SEARCH#[A-F0-9]+:(?:all|\d+):(?:line|match)|RESULT#[a-f0-9-]+/g),
          ].map((match) => match[0]),
        ]
      : [
          ...output.matchAll(
            kind === "breakpoint"
              ? /debug:[a-z0-9-]+\/breakpoint\/[a-z0-9-]+/gi
              : kind === "shell"
                ? /shell:[a-z0-9-]+/gi
                : kind === "debug"
                  ? /debug:[a-z0-9-]+/gi
                  : kind === "change"
                    ? /CHANGE#[A-F0-9]+/g
                    : /(?:SEARCH|RESULT)#[A-F0-9]+(?::[a-z0-9:]+)?|\b\d+#[A-F0-9]+|scope-(?:begin|end)-[A-F0-9]+/g,
          ),
        ].map((match) => match[0]);
  return values(value).some((candidate) => candidate === output || ids.includes(candidate));
}

/** Require successful real executions in order, including result provenance and nesting. */
export function validateRoute(
  task: Pick<CapabilityCase, "steps">,
  events: RunEvent[],
  mode: string,
): { passed: boolean; reasons: string[] } {
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "tool_execution_start");
  const ends = new Map(
    events.flatMap((event, index) =>
      event.type === "tool_execution_end" && event.toolCallId
        ? [[event.toolCallId, { event, index }] as const]
        : [],
    ),
  );
  const reasons: string[] = [];
  const codemodeParents = new Set(
    starts
      .filter(({ event }) => event.toolName === "codemode")
      .map(({ event }) => event.toolCallId),
  );
  let furthest = 0;
  function walk(
    stepIndex: number,
    previousStart: number,
    selected: { event: RunEvent; end: number; parent?: string }[],
  ): boolean {
    furthest = Math.max(furthest, stepIndex);
    const step = task.steps[stepIndex];
    if (!step) return true;
    for (const start of starts) {
      const event = start.event;
      const end = ends.get(event.toolCallId ?? "");
      if (
        start.index <= previousStart ||
        event.toolName !== step.tool ||
        !end ||
        end.index <= start.index ||
        end.event.isError !== (step.error === "direct" ? mode === "direct" : Boolean(step.error))
      )
        continue;
      if (mode === "codemode" && !codemodeParents.has(event.parentToolCallId)) continue;
      if (mode === "direct" && event.parentToolCallId) continue;
      if (step.args && !matches(step.args, event.args)) continue;
      if (step.argsAny && !step.argsAny.some((args) => matches(args, event.args))) continue;
      const output = resultText(end.event);
      if (step.contains && !output.includes(step.contains)) continue;
      if (step.parentExcludes) {
        const parent = ends.get(event.parentToolCallId ?? "");
        if (
          !parent ||
          parent.index <= end.index ||
          parent.event.isError !== false ||
          resultText(parent.event).includes(step.parentExcludes)
        )
          continue;
      }
      if (step.image && !end.event.result?.content?.some((block) => block.type === "image"))
        continue;
      const references = step.reuse ? (Array.isArray(step.reuse) ? step.reuse : [step.reuse]) : [];
      if (
        references.some((reference) => {
          const prior = selected[reference.from];
          return (
            !prior ||
            prior.end >= start.index ||
            !(Array.isArray(reference.field) ? reference.field : [reference.field]).some((field) =>
              reuses(fieldValue(event.args, field), resultText(prior.event), reference.kind),
            ) ||
            (reference.newParent && prior.parent === event.parentToolCallId)
          );
        })
      )
        continue;
      if (
        walk(stepIndex + 1, start.index, [
          ...selected,
          { event: end.event, end: end.index, parent: event.parentToolCallId },
        ])
      )
        return true;
    }
    return false;
  }
  if (!walk(0, -1, []))
    reasons.push(
      `Required step ${furthest + 1} (${task.steps[furthest]?.tool}) was not observed with the required arguments, completed result, reuse, and route`,
    );
  return { passed: reasons.length === 0, reasons };
}

/** Detect missing cases and live tools; this does not claim semantic completeness. */
export function checkCoverage(
  matrix: Capability[],
  cases: CapabilityCase[],
  liveTools: string[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const caseMap = new Map(cases.map((task) => [task.id, task]));
  if (caseMap.size !== cases.length) problems.push("duplicate case ID");
  for (const capability of matrix) {
    if (ids.has(capability.id)) problems.push(`duplicate capability ${capability.id}`);
    ids.add(capability.id);
    if (!capability.cases.length) problems.push(`${capability.id}: no executable case`);
    for (const id of capability.cases)
      if (!caseMap.get(id)?.capabilities.includes(capability.id))
        problems.push(`${capability.id}: broken case link ${id}`);
  }
  for (const task of cases) {
    if (!task.steps.length || !task.modes.length) problems.push(`${task.id}: no route or mode`);
    for (const id of task.capabilities)
      if (!ids.has(id)) problems.push(`${task.id}: unknown capability ${id}`);
      else if (!matrix.find((capability) => capability.id === id)?.cases.includes(task.id))
        problems.push(`${task.id}: missing reverse link for ${id}`);
  }
  const exercised = new Set(cases.flatMap((task) => task.steps.map((step) => step.tool)));
  for (const tool of liveTools)
    if (!exercised.has(tool)) problems.push(`Uncovered live tool: ${tool}`);
  return problems;
}

/** Compare structural schemas without pinning descriptions or prompt wording. */
export function schemaShape(value: unknown, dictionary = false): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => schemaShape(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => dictionary || !["description", "title", "examples", "$id"].includes(key))
        .map((key) => [
          key,
          schemaShape(
            (value as Record<string, unknown>)[key],
            ["properties", "$defs", "definitions", "patternProperties"].includes(key),
          ),
        ]),
    );
  return value;
}
