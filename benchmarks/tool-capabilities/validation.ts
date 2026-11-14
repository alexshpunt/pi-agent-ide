import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/** A retained JSON-mode event; unknown records remain in the evidence. */
export interface RunEvent {
  type: string;
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: {
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    details?: unknown;
  };
  message?: {
    role?: string;
    toolCallId?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string; text?: string; id?: string }[];
    model?: string;
    responseModel?: string;
    provider?: string;
  };
}

/** Identify only selected-connector aliases of real IDE or native Codemode tools. */
export function registeredAliasRoutes(
  tools: {
    name: string;
    parameters: unknown;
    namespace?: { name: string };
    sourceInfo?: { path: string };
  }[],
  connectorRoot: string,
): Record<string, string> {
  if (!connectorRoot.startsWith("/connector/")) return {};
  const sources = tools.filter(
    (tool) =>
      tool.namespace?.name.startsWith("ide_") ||
      (tool.name === "codemode" && tool.sourceInfo?.path === "builtin:codemode"),
  );
  const routes: Record<string, string> = {};
  for (const alias of tools) {
    const owner = alias.sourceInfo?.path;
    if (
      !alias.name.startsWith("mcp__") ||
      alias.namespace !== undefined ||
      !(owner?.startsWith(connectorRoot + "/") || owner === "/source/src/pi-agent-ide.ts")
    )
      continue;
    const matches = sources.filter(
      (source) =>
        alias.name.endsWith("__" + source.name) &&
        JSON.stringify(schemaShape(alias.parameters)) ===
          JSON.stringify(schemaShape(source.parameters)),
    );
    const [source] = matches;
    if (matches.length === 1 && source) routes[alias.name] = source.name;
  }
  return routes;
}
/** Record the assistant's reported identity separately from the requested runtime model. */
export function servedIdentity(
  events: RunEvent[],
  requested: string,
  expectedResponseModel = requested.slice(requested.indexOf("/") + 1),
): { identities: string[]; reasons: string[]; responseModels?: string[] } {
  const messages = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const identities = [
    ...new Set(
      messages.flatMap((message) =>
        message?.provider && message.model ? [`${message.provider}/${message.model}`] : [],
      ),
    ),
  ];
  const reasons: string[] = [];
  if (!identities.length || messages.some((message) => !message?.provider || !message.model))
    reasons.push("No served provider/model identity was observed");
  if (identities.some((identity) => identity !== requested))
    reasons.push("Served provider/model differs from the requested profile");
  const responseModels = [
    ...new Set(
      messages.flatMap((message) => (message?.responseModel ? [message.responseModel] : [])),
    ),
  ];
  if (responseModels.some((model) => model !== expectedResponseModel))
    reasons.push("Reported response model differs from the expected served model");
  return { identities, reasons, ...(responseModels.length ? { responseModels } : {}) };
}
/** A source argument must carry a reference returned by an earlier real execution. */
export interface ResultReuse {
  from: number;
  field: string | string[];
  kind?: string;
  newParent?: boolean;
  /** An explicit argument accepted instead of the reference, such as the path it was read from. */
  explicit?: unknown;
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
  /** Require overlap with an earlier step's execution in the same native Codemode script. */
  parallelWith?: number;
  /** Require two direct tool calls in the same completed assistant message, not a retry. */
  sameAssistantWith?: number;
  /** At least one reviewed argument variant must match, in addition to args. */
  argsAny?: Record<string, unknown>[];
  args?: Record<string, unknown>;
  contains?: string;
  /**
   * Match the public value delivered to a Codemode script, not human-facing text: an object's
   * fields, a string, or a RegExp that a string value must match.
   */
  scriptResult?: Record<string, unknown> | string | RegExp;
  /** Reject copied file text in this tool's own agent-facing result. */
  excludes?: string;
  /** A nested call must not copy this text into its completed Codemode parent's output. */
  parentExcludes?: string;
  /** Require this child in a committed native editor batch with exactly this many calls. */
  editorBatchSize?: number;
  /** Require each fragment in the completed Codemode parent. */
  parentContains?: string | readonly string[];
  /** Require the source object, unchanged by text(receipt), in a completed native Codemode parent. */
  parentStructuredValue?: boolean;
  /** Require a registered transparent local alias to forward the source execution. */
  viaLocalAlias?: boolean;
  /** Check finalized transcript feedback when validation skipped the tool-result hook. */
  finalContains?: string;
  /** Maximum UTF-8 bytes across all text blocks in the finalized tool message, including notices. */
  finalMaxBytes?: number;
  image?: boolean;
  /**
   * Require the native tool_search calls up to this one to have loaded these tools together. One
   * search may load several tools, so a tool may come from a search for another one. tool_search is
   * model-only, so this step is a direct call in Codemode routes too.
   */
  discovers?: readonly string[];
  /** Routes that need this step, such as one only a direct call can take; others skip it. */
  modes?: string[];
  /**
   * `"direct"`: a direct call fails; in Codemode the call fails itself or is accepted and its
   * parent reports the write failure.
   */
  error?: boolean | "direct";
  reuse?: ResultReuse | ResultReuse[];
}

/** An executable task may protect several related capabilities. */
export interface CapabilityCase {
  id: string;
  capabilities: string[];
  modes: string[];
  steps: RouteStep[];
  /** Reject these tool executions anywhere in the attempt, including registered aliases. */
  forbiddenTools?: readonly string[];
  prompt?: string;
  files?: Record<string, string>;
  expected?: Record<string, string | Buffer | null>;
  answer?: string;
  prerequisite?: string;
  setup?: string;
  git?: boolean;
  /** Keep IDE post-processing, such as formatting, which the runner otherwise disables. */
  postProcessing?: boolean;
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
  if (expected instanceof RegExp)
    // A Codemode value passed as a source, such as a Search match, counts by its id.
    return typeof actual === "string"
      ? expected.test(actual)
      : values(actual).length === 1 && expected.test(values(actual)[0] ?? "");
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      // Items of a list field, such as several paths, compare like the field itself.
      (expected as unknown[]).every((value, i) => matches(value, (actual as unknown[])[i], field))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        matches(value, (actual as Record<string, unknown>)[key], key),
      )
    );
  if (["path", "file", "target"].includes(field) && typeof expected === "string") {
    // A list of one source, such as a file_search value, names the same source.
    const source = Array.isArray(actual) && actual.length === 1 ? (actual[0] as unknown) : actual;
    return typeof source === "string" && fixturePath(expected) === fixturePath(source);
  }
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
  // A Codemode value passed as a source counts by its id.
  if (value !== null && typeof value === "object" && "id" in value)
    return typeof value.id === "string" ? [value.id] : [];
  return typeof value === "string" ? [value] : [];
}

/** The `id` of a Codemode value and of every value inside it, such as each Search match. */
function valueIds(value: unknown): string[] {
  if (Array.isArray(value)) return (value as unknown[]).flatMap(valueIds);
  if (value === null || typeof value !== "object") return [];
  const own = "id" in value && typeof value.id === "string" ? [value.id] : [];
  return [...own, ...Object.values(value).flatMap(valueIds)];
}

/** A Codemode value passed on unchanged, such as a Read image block, reuses the result it came from. */
function passesValue(value: unknown, prior: RunEvent): boolean {
  const own = prior.result?.structuredContent;
  return (
    value !== null &&
    typeof value === "object" &&
    own !== null &&
    typeof own === "object" &&
    isDeepStrictEqual(value, own)
  );
}

function reuses(
  value: unknown,
  output: string,
  kind = "result",
  issued: readonly string[] = [],
): boolean {
  const ids =
    kind === "result"
      ? [
          // A Codemode value names an enveloped result by its `RESULT#<uuid>` id.
          ...[...output.matchAll(/<uuid>([a-f0-9-]+)<\/uuid>/gi)].flatMap((match) => [
            match[1] ?? "",
            `RESULT#${match[1] ?? ""}`,
          ]),
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
                    : /(?:SEARCH|RESULT)#[A-F0-9]+(?::[a-z0-9:]+)?|[0-9A-HJKMNP-TV-Z]{7}(?=\|)|scope-(?:begin|end)-[0-9A-HJKMNP-TV-Z]{7}/g,
          ),
        ].map((match) => match[0]);
  return values(value).some(
    (candidate) =>
      candidate === output ||
      ids.includes(candidate) ||
      // A Codemode value issues its own ids, such as the id of each Search match.
      (["result", "anchor"].includes(kind) && issued.includes(candidate)) ||
      // `RESULT#<uuid>` names the result whose envelope carries that UUID.
      (kind === "result" && ids.includes(candidate.replace(/^RESULT#/u, ""))),
  );
}

/** Require successful real executions in order, including result provenance and nesting. */
export function validateRoute(
  task: Pick<CapabilityCase, "steps" | "forbiddenTools">,
  events: RunEvent[],
  mode: string,
  aliases: Readonly<Record<string, string>> = {},
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
  for (const { event } of starts) {
    const name = aliases[event.toolName ?? ""] ?? event.toolName;
    if (name !== undefined && task.forbiddenTools?.includes(name))
      return { passed: false, reasons: [`Forbidden tool executed: ${name}`] };
  }
  const codemodeParents = new Set(
    starts
      .filter(({ event }) => event.toolName === "codemode")
      .map(({ event }) => event.toolCallId),
  );
  const startsById = new Map(starts.map((start) => [start.event.toolCallId, start]));
  // A wrapper is transparent only when its registered alias, arguments, result and
  // single actual child execution all agree. Raw events are never renamed.
  function executionParent(
    start: (typeof starts)[number],
  ): { parent?: string; call?: string } | undefined {
    let current = start;
    const visited = new Set<string>();
    while (current.event.parentToolCallId) {
      const parentId = current.event.parentToolCallId;
      if (visited.has(parentId)) return undefined;
      visited.add(parentId);
      const parent = startsById.get(parentId);
      if (!parent) return undefined;
      if (aliases[parent.event.toolName ?? ""] !== current.event.toolName)
        return { parent: parentId, call: current.event.toolCallId };
      const end = ends.get(current.event.toolCallId ?? "");
      const parentEnd = ends.get(parentId);
      if (
        parent.index >= current.index ||
        !end ||
        !parentEnd ||
        parentEnd.index <= end.index ||
        parentEnd.event.isError !== end.event.isError ||
        !matches(parent.event.args, current.event.args) ||
        !matches(current.event.args, parent.event.args) ||
        JSON.stringify(parentEnd.event.result?.content) !==
          JSON.stringify(end.event.result?.content) ||
        !isDeepStrictEqual(
          parentEnd.event.result?.structuredContent,
          end.event.result?.structuredContent,
        ) ||
        starts.filter(({ event }) => event.parentToolCallId === parentId).length !== 1
      )
        return undefined;
      current = parent;
    }
    return { call: current.event.toolCallId };
  }
  /** Tools that successful native tool_search calls started up to `index` reported as loaded. */
  function discovered(index: number): Set<string> {
    return new Set(
      starts.flatMap(({ event, index: startIndex }) => {
        const end = ends.get(event.toolCallId ?? "")?.event;
        const loaded = (end?.result?.details as { loaded?: unknown } | undefined)?.loaded;
        return startIndex <= index &&
          event.toolName === "tool_search" &&
          !event.parentToolCallId &&
          end?.isError === false &&
          Array.isArray(loaded)
          ? loaded.filter((name): name is string => typeof name === "string")
          : [];
      }),
    );
  }
  /**
   * The paths an earlier completed call read or searched to issue the result that a source value
   * reuses: passing that result names the same file as passing its path.
   */
  function reusedPaths(value: unknown, before: number): string[] {
    for (const prior of starts) {
      const end = ends.get(prior.event.toolCallId ?? "");
      if (prior.index >= before || !end || end.index >= before || end.event.isError) continue;
      if (
        !["result", "anchor"].some((kind) =>
          reuses(value, resultText(end.event), kind, valueIds(end.event.result?.structuredContent)),
        )
      )
        continue;
      // A Codemode parent can print a child's id; only a call with a path issued it.
      const source = prior.event.args?.path;
      if (source === undefined) continue;
      const sources = Array.isArray(source) ? (source as unknown[]) : [source];
      const paths = sources.flatMap((item) =>
        typeof item === "string" ? [item] : reusedPaths(item, prior.index),
      );
      if (paths.length > 0) return paths;
    }
    return [];
  }
  /**
   * Arguments match. For an edit, a reused result of the expected file also stands for its path:
   * the edit's selectors resolve inside that result. A search with a result is narrower, so it
   * keeps the exact path.
   */
  function argsMatch(
    tool: string,
    expected: Record<string, unknown>,
    actual: Record<string, unknown> | undefined,
    before: number,
  ): boolean {
    if (!actual) return false;
    // Read's first line is the default, not a different selection.
    const normalized = { ...actual };
    if (["read", "demo_read"].includes(tool) && normalized.offset === undefined)
      normalized.offset = 1;
    if (matches(expected, normalized)) return true;
    if (!["replace", "delete", "insert", "copy", "move"].includes(tool)) return false;
    const { path: file, ...rest } = expected;
    // A real issued line anchor can name the exact line required by the route.
    for (const field of ["anchor", "start", "end"]) {
      const selector = normalized[field];
      const exact = rest[field];
      if (typeof exact !== "string" || typeof selector !== "string") continue;
      const hash = /^([0-9A-HJKMNP-TV-Z]{7})(?:\|[^\r\n]*)?$/u.exec(selector)?.[1];
      if (!hash) continue;
      const issuer = starts.some((prior) => {
        const end = ends.get(prior.event.toolCallId ?? "");
        if (
          prior.index >= before ||
          !end ||
          end.index >= before ||
          end.event.isError ||
          !["read", "demo_read"].includes(prior.event.toolName ?? "")
        )
          return false;
        if (file !== undefined && !matches({ path: file }, prior.event.args)) return false;
        return resultText(end.event)
          .split(/\r?\n/u)
          .some((line) => line === `${hash}|${exact}` && (selector === hash || selector === line));
      });
      if (issuer) normalized[field] = rest[field];
    }
    if (matches(expected, normalized)) return true;
    if (!(typeof file === "string" || file instanceof RegExp) || !matches(rest, normalized))
      return false;
    // A selector can carry its own source. Never rescue an explicitly wrong path with it.
    const source = actual.path !== undefined ? actual.path : (actual.anchor ?? actual.start);
    return reusedPaths(source, before).some((path) => matches({ path: file }, { path }));
  }
  let furthest = 0;
  function walk(
    stepIndex: number,
    previousStart: number,
    // A step that another route skips leaves its slot empty; steps reusing it cannot match.
    selected: ({ event: RunEvent; end: number; parent?: string; call?: string } | undefined)[],
  ): boolean {
    furthest = Math.max(furthest, stepIndex);
    const step = task.steps[stepIndex];
    if (!step) return true;
    if (step.modes && !step.modes.includes(mode))
      return walk(stepIndex + 1, previousStart, [...selected, undefined]);
    // In Codemode, a native text call either fails at once, such as one with a result-bound
    // selector, or is accepted into a batch whose commit fails its parent.
    const acceptedOrFailed = step.error === "direct" && mode === "codemode";
    for (const start of starts) {
      const event = start.event;
      const end = ends.get(event.toolCallId ?? "");
      if (
        start.index <= previousStart ||
        event.toolName !== step.tool ||
        !end ||
        end.index <= start.index ||
        (!acceptedOrFailed && end.event.isError !== Boolean(step.error))
      )
        continue;
      const execution = executionParent(start);
      if (!execution) continue;
      if (step.viaLocalAlias && (!execution.call || execution.call === event.toolCallId)) continue;
      if (step.discovers) {
        if (execution.parent || !step.discovers.every((name) => discovered(start.index).has(name)))
          continue;
      } else if (mode === "codemode" && !codemodeParents.has(execution.parent)) continue;
      // An accepted native text call fails when its parent commits the batch.
      if (
        acceptedOrFailed &&
        !end.event.isError &&
        ends.get(execution.parent ?? "")?.event.isError !== true
      )
        continue;
      if (
        step.scriptResult !== undefined &&
        !matches(step.scriptResult, end.event.result?.structuredContent)
      )
        continue;
      if (mode === "direct" && execution.parent) continue;
      if (step.parallelWith !== undefined) {
        const prior = selected[step.parallelWith];
        if (
          mode !== "codemode" ||
          prior === undefined ||
          start.index >= prior.end ||
          prior.parent !== execution.parent
        )
          continue;
      }
      if (step.sameAssistantWith !== undefined) {
        const prior = selected[step.sameAssistantWith];
        if (
          mode !== "direct" ||
          prior === undefined ||
          !events.some(
            (entry) =>
              entry.type === "message_end" &&
              entry.message?.role === "assistant" &&
              entry.message.content?.some(
                (block) => block.type === "toolCall" && block.id === execution.call,
              ) &&
              entry.message.content.some(
                (block) => block.type === "toolCall" && block.id === prior.call,
              ),
          )
        )
          continue;
      }
      if (step.args && !argsMatch(step.tool, step.args, event.args, start.index)) continue;
      if (
        step.argsAny &&
        !step.argsAny.some((args) => argsMatch(step.tool, args, event.args, start.index))
      )
        continue;
      const output = resultText(end.event);
      if (step.contains && !output.includes(step.contains)) continue;
      if (step.finalContains !== undefined || step.finalMaxBytes !== undefined) {
        const finalized = events.findLast(
          (entry) =>
            entry.type === "message_end" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolCallId === execution.call,
        )?.message;
        if (
          !finalized ||
          !Array.isArray(finalized.content) ||
          finalized.isError !== end.event.isError ||
          (step.finalContains !== undefined &&
            !finalized.content.some(
              (block) => block.type === "text" && block.text?.includes(step.finalContains ?? ""),
            )) ||
          (step.finalMaxBytes !== undefined &&
            Buffer.byteLength(
              finalized.content
                .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
                .join("\n"),
            ) > step.finalMaxBytes)
        )
          continue;
      }
      if (step.excludes && output.includes(step.excludes)) continue;
      if (step.editorBatchSize !== undefined) {
        const parent = ends.get(execution.parent ?? "");
        const details = parent?.event.result?.details as
          | {
              editorBatches?: { applied: boolean; calls: { id: string }[] }[];
            }
          | undefined;
        if (
          !parent ||
          parent.index <= end.index ||
          parent.event.isError !== false ||
          !details?.editorBatches?.some(
            (batch) =>
              batch.applied &&
              batch.calls.length === step.editorBatchSize &&
              batch.calls.some((call) => call.id === event.toolCallId),
          )
        )
          continue;
      }
      if (step.parentExcludes || step.parentContains || step.parentStructuredValue) {
        const parent = ends.get(execution.parent ?? "");
        const parentStart = startsById.get(execution.parent);
        const value = end.event.result?.structuredContent;
        if (
          !parent ||
          parent.index <= end.index ||
          parent.event.isError !== false ||
          (step.parentStructuredValue &&
            (mode !== "codemode" ||
              !parentStart ||
              parentStart.index >= start.index ||
              value === null ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              !resultText(parent.event).includes(JSON.stringify(value)))) ||
          (step.parentExcludes !== undefined &&
            resultText(parent.event).includes(step.parentExcludes)) ||
          (step.parentContains !== undefined &&
            (typeof step.parentContains === "string"
              ? [step.parentContains]
              : step.parentContains
            ).some((fragment) => !resultText(parent.event).includes(fragment)))
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
            !(Array.isArray(reference.field) ? reference.field : [reference.field]).some(
              (field) =>
                (reference.explicit !== undefined &&
                  matches(
                    reference.explicit,
                    fieldValue(event.args, field),
                    field.split(".").at(-1),
                  )) ||
                reuses(
                  fieldValue(event.args, field),
                  resultText(prior.event),
                  reference.kind,
                  valueIds(prior.event.result?.structuredContent),
                ) ||
                passesValue(fieldValue(event.args, field), prior.event),
            ) ||
            (reference.newParent && prior.parent === execution.parent)
          );
        })
      )
        continue;
      if (
        walk(stepIndex + 1, start.index, [
          ...selected,
          { event: end.event, end: end.index, parent: execution.parent, call: execution.call },
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
