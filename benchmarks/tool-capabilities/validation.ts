import path from "node:path";
import { executionArguments, toolSemantics } from "./argument-equivalence.ts";
import { searchCallPolicy } from "#src/extensions/pi-agent-search/src/api/search-call-policy.ts";
import {
  exactSelection,
  issuedAnchor,
  issuedSelection,
  issuedSearchFragment,
  readSourceIssuers,
  searchSources,
  wholeSearchSelection,
  type SelectionIssuer,
} from "./selection-evidence.ts";
import { isDeepStrictEqual } from "node:util";
import {
  equivalentLineArguments,
  wholeLineSelection,
  type LineSelection,
} from "./edit-equivalence.ts";

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
  /** Require completion of these earlier declared steps before this call starts. */
  after?: readonly number[];
  /** Require overlap with an earlier step's execution in the same native Codemode script. */
  parallelWith?: number;
  /** Require one direct assistant message or overlapping children of one native script. */
  sameAssistantWith?: number;
  /** Only capability-defining arguments and call discriminators, not an example call. */
  args?: Record<string, unknown>;
  /** Exercise literal text selection without pinning a boundary spelling; outcomes check bytes. */
  exactText?: readonly string[];
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
  /** Require a committed native batch of this size; share it with a batched sameAssistantWith step. */
  editorBatchSize?: number;
  /** Require each fragment in the completed Codemode parent. */
  parentContains?: string | readonly string[];
  /** Require the source object, unchanged by text(receipt), in a completed native Codemode parent. */
  parentStructuredValue?: boolean;
  /** Check finalized transcript feedback when validation skipped the tool-result hook. */
  finalContains?: string;
  /** Maximum UTF-8 bytes across all text blocks in the finalized tool message, including notices. */
  finalMaxBytes?: number;
  /** Require image blocks in the completed result; a number sets the minimum frame count. */
  image?: boolean | number;
  /**
   * Require successful native discovery of these tools, each before its first execution. Searches
   * may load tools incrementally or together. Only direct routes require model-only discovery.
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

/** Native Codemode tools do not depend on model-only discovery, even in mixed routes. */
export function routeStepApplies(step: RouteStep, mode: string): boolean {
  return (
    !(mode === "codemode" && step.tool === "tool_search") &&
    (!step.modes || step.modes.includes(mode))
  );
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
  /** Override the neutral prompt after Pi selects the profile's actual model API. */
  promptForApi?: (api?: string) => string;
  files?: Record<string, string>;
  expected?: Record<string, string | Buffer | null>;
  answer?: string;
  prerequisite?: string;
  /** Exclusive resource within an invocation, held through setup, execution and cleanup. */
  resource?: string;
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

function fixturePath(value: string, cwd = "."): string {
  if (/^https?:/.test(value)) return new URL(value).href;
  const prefix = value.startsWith("raw:") ? "raw:" : "";
  const source = value.slice(prefix.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file://")) return value;
  const absolute = source.startsWith("file://") ? new URL(source).pathname : source;
  const resolved = path.posix.resolve("/workspace/fixture", cwd, absolute);
  return prefix + path.posix.relative("/workspace/fixture", resolved);
}

function debugProgram(args: Record<string, unknown>): unknown {
  return typeof args.program === "string"
    ? fixturePath(args.program, typeof args.cwd === "string" ? fixturePath(args.cwd) : ".")
    : args.program;
}
function diffSource(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).every(([field, item]) => field === "path" || item === undefined) &&
    "path" in value &&
    typeof value.path === "string"
  )
    return value.path;
  return value;
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
  if (
    ["path", "file", "target", "program", "cwd"].includes(field) &&
    typeof expected === "string"
  ) {
    // A list of one source, such as a file_search value, names the same source.
    const source =
      !["program", "cwd"].includes(field) && Array.isArray(actual) && actual.length === 1
        ? (actual[0] as unknown)
        : actual;
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
  const own = Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" &&
    (key === "id" ||
      (["target", "line", "match"].includes(key) && /^(?:RESULT|SEARCH)#/u.test(item)))
      ? [item]
      : [],
  );
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
  return values(value).some((raw) => {
    const candidate = kind === "anchor" ? (issuedAnchor(raw, output) ?? raw) : raw;
    // A bare selection UUID names the same issued target, not a different source.
    const references = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u.test(candidate)
      ? [candidate, `RESULT#${candidate}`]
      : [candidate];
    return (
      candidate === output ||
      references.some(
        (reference) =>
          ids.includes(reference) ||
          // A Codemode value issues its own ids, such as the id of each Search match.
          (["result", "anchor"].includes(kind) && issued.includes(reference)) ||
          // `RESULT#<uuid>` names the result whose envelope carries that UUID.
          (kind === "result" && ids.includes(reference.replace(/^RESULT#/u, ""))),
      )
    );
  });
}

/** Assign distinct real executions, respecting declared dependencies, provenance and nesting. */
export function validateRoute(
  task: Pick<CapabilityCase, "steps" | "forbiddenTools" | "files">,
  events: RunEvent[],
  mode: string,
  aliases: Readonly<Record<string, string>> = {},
): { passed: boolean; reasons: string[] } {
  const starts = events
    .map((event, index) => ({
      event:
        event.type === "tool_execution_start"
          ? {
              ...event,
              args: executionArguments(
                aliases[event.toolName ?? ""] ?? event.toolName ?? "",
                event.args,
              ),
            }
          : event,
      index,
    }))
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
  /** Tools reported as loaded by successful native searches completed before `index`. */
  function discovered(index: number): Set<string> {
    return new Set(
      starts.flatMap(({ event }) => {
        const end = ends.get(event.toolCallId ?? "");
        const loaded = (end?.event.result?.details as { loaded?: unknown } | undefined)?.loaded;
        return end &&
          end.index < index &&
          event.toolName === "tool_search" &&
          !event.parentToolCallId &&
          end.event.isError === false &&
          Array.isArray(loaded)
          ? loaded.filter((name): name is string => typeof name === "string")
          : [];
      }),
    );
  }
  const requiredDiscovery =
    mode === "direct"
      ? task.steps.flatMap((step) =>
          routeStepApplies(step, mode) ? [...(step.discovers ?? [])] : [],
        )
      : [];
  if (
    requiredDiscovery.some(
      (tool) =>
        !discovered(events.length).has(tool) ||
        starts.some((start) => start.event.toolName === tool && !discovered(start.index).has(tool)),
    )
  )
    reasons.push("Required tools were not discovered before use");
  /**
   * The paths an earlier completed call read or searched to issue the result that a source value
   * reuses: passing that result names the same file as passing its path.
   */
  function reusedPaths(value: unknown, before: number): string[] {
    for (const prior of starts) {
      const end = ends.get(prior.event.toolCallId ?? "");
      if (prior.index >= before || !end || end.index >= before || end.event.isError) continue;
      const tool = aliases[prior.event.toolName ?? ""] ?? prior.event.toolName ?? "";
      if (toolSemantics(tool) === "read" && Array.isArray(prior.event.args?.path)) {
        const sources = readSourceIssuers({ tool, args: prior.event.args, end: end.event });
        const paths = sources.flatMap((issuer) => {
          // Text can quote a foreign RESULT id. Only this item's own id or line anchors count.
          const output = "";
          if (
            !reuses(value, output, "result", valueIds(issuer.end.result?.structuredContent)) &&
            !issuedAnchor(value, resultText(issuer.end))
          )
            return [];
          const source = issuer.args.path;
          return typeof source === "string" && !/^(?:RESULT|SEARCH)#/u.test(source)
            ? [source]
            : reusedPaths(source, prior.index);
        });
        if (paths.length) return paths;
        continue;
      }
      if (
        !["result", "anchor", "change"].some((kind) =>
          reuses(value, resultText(end.event), kind, valueIds(end.event.result?.structuredContent)),
        )
      )
        continue;
      if ((aliases[prior.event.toolName ?? ""] ?? prior.event.toolName) === "search") {
        const sources = searchSources(value, end.event);
        if (sources !== undefined) return sources;
        if (Array.isArray(prior.event.args?.path) && prior.event.args.path.length !== 1) return [];
      }
      // A Codemode parent can print a child's id; only a call with a path issued it.
      const source = prior.event.args?.path ?? prior.event.args?.file;
      if (source === undefined) continue;
      const sources = Array.isArray(source) ? (source as unknown[]) : [source];
      const paths = sources.flatMap((item) =>
        typeof item === "string" && !/^(?:RESULT|SEARCH)#/u.test(item)
          ? [item]
          : reusedPaths(item, prior.index),
      );
      if (paths.length > 0) return paths;
    }
    return [];
  }
  /** Only successful, completed issuers of this same source may justify selector equivalence. */
  function selectionIssuers(
    file: unknown,
    before: number,
  ): (SelectionIssuer & { start: number })[] {
    return starts.flatMap((prior) => {
      const end = ends.get(prior.event.toolCallId ?? "");
      if (prior.index >= before || !end || end.index >= before || end.event.isError) return [];
      return readSourceIssuers({
        tool: aliases[prior.event.toolName ?? ""] ?? prior.event.toolName ?? "",
        args: prior.event.args ?? {},
        end: end.event,
      }).flatMap((issuer) => {
        const source = issuer.args.path;
        const paths = [...values(source), ...reusedPaths(source, prior.index)];
        if (file !== undefined && !paths.some((path) => matches({ path: file }, { path })))
          return [];
        return [{ ...issuer, start: prior.index }];
      });
    });
  }
  /** A literal file beside a reference must be the reference issuer's source, not a different file. */
  function sameSource(file: unknown, reference: unknown, before: number): boolean {
    return (
      typeof file === "string" &&
      reusedPaths(reference, before).some((path) => fixturePath(path) === fixturePath(file))
    );
  }
  /** Direct editor receipts identify calls planned against one shared snapshot. */
  function sharesDirectSnapshot(prior: RunEvent, current: RunEvent | undefined): boolean {
    if (
      mode !== "direct" ||
      !current ||
      !["replace", "insert", "delete", "copy", "move"].includes(prior.toolName ?? "")
    )
      return false;
    const first = ends.get(prior.toolCallId ?? "")?.event;
    const second = ends.get(current.toolCallId ?? "")?.event;
    if (first?.isError !== false || second?.isError !== false) return false;
    type Receipt = { agenticIdeBatch?: { batchId?: string; calls?: ({ id?: string } | null)[] } };
    const batch = (first.result?.details as Receipt | undefined)?.agenticIdeBatch;
    const peer = (second.result?.details as Receipt | undefined)?.agenticIdeBatch;
    const calls = batch?.calls;
    return (
      typeof batch?.batchId === "string" &&
      batch.batchId.length > 0 &&
      isDeepStrictEqual(batch, peer) &&
      Array.isArray(calls) &&
      [prior.toolCallId, current.toolCallId].every(
        (id) => typeof id === "string" && calls.some((call) => call?.id === id),
      )
    );
  }
  /** An edit overlapping or following the witness makes its source snapshot unsafe. */
  function sourceChanged(file: string, before: number, after = -1): boolean {
    for (const prior of starts) {
      const end = ends.get(prior.event.toolCallId ?? "");
      if (
        prior.index >= before ||
        (end && (end.index <= after || end.event.isError)) ||
        sharesDirectSnapshot(prior.event, events[before])
      )
        continue;
      if (
        !["write", "replace", "insert", "delete", "copy", "move", "undo"].includes(
          aliases[prior.event.toolName ?? ""] ?? prior.event.toolName ?? "",
        )
      )
        continue;
      const args = prior.event.args ?? {};
      const affected =
        (aliases[prior.event.toolName ?? ""] ?? prior.event.toolName) === "copy"
          ? [args.target]
          : [args.path, args.anchor, args.start, args.target, args.file];
      if (
        affected.some((value) =>
          [...values(value), ...reusedPaths(value, prior.index)].some(
            (candidate) => fixturePath(candidate) === fixturePath(file),
          ),
        )
      )
        return true;
    }
    return false;
  }
  /** Recover fixture bytes only while earlier successful edits have not invalidated them. */
  function editContext(
    tool: string,
    actual: Record<string, unknown>,
    before: number,
  ): {
    content?: string;
    selection?: LineSelection;
  } {
    const source = actual.path ?? actual.anchor ?? actual.start;
    const paths = [...values(source), ...reusedPaths(source, before)];
    const file = Object.keys(task.files ?? {}).find((file) =>
      paths.some((candidate) => fixturePath(candidate) === fixturePath(file)),
    );
    if (file === undefined) return {};
    if (sourceChanged(file, before)) return {};
    const content = task.files?.[file];
    if (content === undefined) return {};
    const selector = actual.anchor ?? actual.start;
    if (selector !== undefined) {
      const issuers = selectionIssuers(file, before);
      const whole = (value: unknown): LineSelection | undefined => {
        const selected =
          wholeLineSelection(content, value) ??
          issuedSelection(content, value, issuers, (source) =>
            matches({ path: file }, { path: source }),
          );
        // Issued inline matches cannot supply a whole line's terminal separator.
        return selected &&
          (selected.from === 0 || content[selected.from - 1] === "\n") &&
          (selected.to === content.length || content[selected.to - 1] === "\n")
          ? selected
          : undefined;
      };
      const first = whole(selector);
      const last = actual.end === undefined ? first : whole(actual.end);
      if (first && last && first.from <= last.from)
        return { content, selection: { content, from: first.from, to: last.to } };
    }
    const reference = selector ?? actual.path;
    for (const prior of starts) {
      const end = ends.get(prior.event.toolCallId ?? "");
      if (prior.index >= before || !end || end.index >= before || end.event.isError) continue;
      if (
        !reuses(
          reference,
          resultText(end.event),
          "result",
          valueIds(end.event.result?.structuredContent),
        )
      )
        continue;
      // A :line reference always owns its line separator when every fixture line is terminated.
      // Its exact position is not inferred, so this witness is used only for replacement.
      if (
        tool === "replace" &&
        typeof reference === "string" &&
        /^SEARCH#[A-F0-9]+:(?:all|\d+):line$/u.test(reference) &&
        prior.event.toolName === "search" &&
        content.endsWith("\n") &&
        actual.end === undefined
      )
        return { content, selection: { content, from: 0, to: content.length } };
      // Plain Read windows select whole lines; transformed views and Search matches do not.
      if (selector !== undefined || prior.event.toolName !== "read") continue;
      const args = prior.event.args ?? {};
      if (Array.isArray(args.views) && args.views.some((view) => view !== "anchors")) continue;
      const offset = args.offset ?? 1;
      const limit = args.limit;
      const lines = [0, ...[...content.matchAll(/\n/gu)].map((match) => match.index + 1)].filter(
        (index) => index < content.length,
      );
      if (
        typeof offset !== "number" ||
        !Number.isInteger(offset) ||
        offset < 1 ||
        (limit !== undefined &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1))
      )
        continue;
      const from = lines[offset - 1];
      if (from === undefined) continue;
      const to =
        limit === undefined ? content.length : (lines[offset - 1 + limit] ?? content.length);
      return { content, selection: { content, from, to } };
    }
    return { content };
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
    sourceListItem = false,
  ): boolean {
    if (!actual) return false;
    tool = toolSemantics(tool);
    // Defaults describe execution semantics; they never rewrite retained call evidence.
    const normalized = { ...actual };
    if (tool === "debug" && typeof expected.program === "string") {
      // A relative program is launched from this call's cwd, not necessarily the fixture root.
      expected = { ...expected, program: debugProgram(expected) };
      normalized.program = debugProgram(normalized);
    }
    if (tool === "read" && normalized.offset === undefined)
      normalized.offset = typeof actual.path === "string" && actual.path.startsWith("raw:") ? 0 : 1;
    if (tool === "insert") {
      if (normalized.before === undefined) normalized.before = false;
      if (normalized.separation === undefined) normalized.separation = "line";
    }
    if (tool === "search") {
      for (const flag of ["caseSensitive", "wholeWord", "multiline"])
        if (normalized[flag] === undefined) normalized[flag] = false;
      // A result reference or extension URI does not reveal its resolver or limit policy.
      const source = normalized.path;
      if (normalized.limit === undefined && typeof source === "string") {
        if (/^(?:docs:|https?:)/u.test(source)) normalized.limit = 50;
        else if (source.startsWith("shell:")) normalized.limit = 100;
        else if (!/^[a-z][a-z0-9+.-]*:|^(?:RESULT|SEARCH)#/iu.test(source))
          normalized.limit =
            searchCallPolicy(undefined, mode === "codemode", "matches").limit ?? 50;
      }
    }
    // Search roots form an unordered collection. Transfer source/target arrays remain paired.
    if (
      ["search", "file_search", "ast_search", "lsp_search"].includes(tool) &&
      Array.isArray(expected.path) &&
      Array.isArray(normalized.path)
    ) {
      const remaining = [...(normalized.path as unknown[])];
      for (const required of expected.path) {
        const index = remaining.findIndex((root) => matches(required, root, "path"));
        if (index < 0) return false;
        remaining.splice(index, 1);
      }
      if (remaining.length) return false;
      normalized.path = expected.path;
    }
    // Read views are requirements, not positional output fields; other arrays stay ordered.
    const views = normalized.views;
    if (
      tool === "read" &&
      Array.isArray(expected.views) &&
      Array.isArray(views) &&
      expected.views.every((required) => views.some((view) => matches(required, view)))
    )
      normalized.views = expected.views.map((required) =>
        (views as unknown[]).find((view) => matches(required, view)),
      );
    if (tool === "diff")
      return Object.entries(expected).every(([field, value]) => {
        if (!["before", "after"].includes(field)) return matches(value, normalized[field], field);
        const source = diffSource(value);
        const other = diffSource(normalized[field]);
        return typeof source === "string" && typeof other === "string"
          ? fixturePath(source) === fixturePath(other)
          : matches(source, other);
      });
    if (matches(expected, normalized)) return true;
    // One Read may include other sources, but must satisfy every required argument on that call.
    if (
      tool === "read" &&
      Array.isArray(normalized.path) &&
      (typeof expected.path === "string" || expected.path instanceof RegExp)
    )
      return normalized.path.some((path: unknown) => matches(expected, { ...normalized, path }));
    // A debugger source and its launched program name the same file, with the same requested views.
    if (tool === "read" && !sourceListItem) {
      for (const prior of selectionIssuers(undefined, before)) {
        if (
          prior.tool !== "debug" ||
          !matches({ path: debugProgram(prior.args) }, { path: actual.path })
        )
          continue;
        const resources = resultText(prior.end).match(/debug:[a-z0-9-]+/giu) ?? [];
        if (
          resources.some((resource) =>
            matches(expected, { ...normalized, path: `${resource}/source` }),
          )
        )
          return true;
      }
    }
    if (["undo", "stage", "unstage"].includes(tool)) {
      if (actual.file === undefined) {
        const files = [
          ...new Set(reusedPaths(actual.change, before).map((source) => fixturePath(source))),
        ];
        if (files.length === 1) normalized.file = files[0];
      }
      return matches(expected, normalized);
    }
    if (!["replace", "delete", "insert", "copy", "move"].includes(tool)) return false;
    const file = expected.path;
    const location = actual.anchor ?? actual.start;
    // Infer sources only from issued references; an explicit different file is never rescued.
    for (const [sourceField, selector] of [
      ["path", location],
      ["target", actual.targetStart],
    ] as const) {
      const source = actual[sourceField] ?? selector;
      const paths = [...new Set(reusedPaths(source, before).map((source) => fixturePath(source)))];
      if (
        (typeof expected[sourceField] === "string" || expected[sourceField] instanceof RegExp) &&
        paths.length === 1 &&
        matches(expected[sourceField], paths[0], sourceField)
      )
        normalized[sourceField] = paths[0];
    }
    // A complete single-match Search's match and whole-result reference name the same selection.
    const selection = location ?? actual.path;
    if (
      file instanceof RegExp &&
      selection !== undefined &&
      (location === undefined ||
        actual.path === undefined ||
        sameSource(actual.path, location, before))
    ) {
      if (matches(file, selection)) normalized.path = selection;
      else
        for (const issuer of selectionIssuers(undefined, before)) {
          if (issuer.tool !== "search" || !wholeSearchSelection(selection, issuer.end)) continue;
          const references = valueIds(issuer.end.result?.structuredContent);
          const envelope = /<uuid>([a-f0-9-]+)<\/uuid>/iu.exec(resultText(issuer.end))?.[1];
          if (envelope) references.push(`RESULT#${envelope}`);
          const equivalent = references.find(
            (reference) => matches(file, reference) && wholeSearchSelection(reference, issuer.end),
          );
          if (equivalent) normalized.path = equivalent;
        }
    }
    for (const field of ["anchor", "start", "end", "targetStart", "targetEnd"]) {
      const target = field.startsWith("target");
      const source = target ? expected.target : file;
      const actualSource = target ? actual.target : actual.path;
      if (
        source !== undefined &&
        actualSource !== undefined &&
        !matches({ path: source }, { path: actualSource }) &&
        !sameSource(source, actualSource, before)
      )
        continue;
      const issuers = selectionIssuers(source, before);
      const selector =
        normalized[field] ??
        (["start", "anchor"].includes(field)
          ? actual.path
          : field === "targetStart"
            ? actual.target
            : undefined);
      const exact = expected[field];
      // A source or target result already selects its issued range without a separate start.
      if (
        exact instanceof RegExp &&
        ["start", "anchor", "targetStart"].includes(field) &&
        normalized[field] === undefined &&
        sameSource(source, selector, before) &&
        matches(exact, selector)
      )
        normalized[field] = selector;
      const hash = issuers
        .map((issuer) => issuedAnchor(selector, resultText(issuer.end)))
        .find(Boolean);
      if (hash && exact instanceof RegExp && matches(exact, hash)) normalized[field] = hash;
      if (typeof source !== "string" || typeof exact !== "string") continue;
      const content = editContext(tool, { path: source }, before).content;
      const paired = target ? expected.targetEnd !== undefined : expected.end !== undefined;
      if (content === undefined) {
        if (
          issuedSearchFragment(
            exact,
            selector,
            paired,
            issuers.filter((issuer) => !sourceChanged(source, before, issuer.start)),
            (candidate) => matches({ path: source }, { path: candidate }),
          )
        )
          normalized[field] = exact;
        continue;
      }
      const required = exactSelection(content, exact, paired);
      const selected = issuedSelection(content, selector, issuers, (candidate) =>
        matches({ path: source }, { path: candidate }),
      );
      if (required && selected && required.from === selected.from && required.to === selected.to)
        normalized[field] = exact;
    }
    const context = editContext(tool, normalized, before);
    return matches(
      expected,
      equivalentLineArguments(
        tool,
        expected,
        normalized,
        context.content,
        context.selection,
        matches,
      ),
    );
  }
  function argumentReuses(
    field: string,
    args: Record<string, unknown> | undefined,
    reference: ResultReuse,
    prior: RunEvent,
    before: number,
    readItem = false,
  ): boolean {
    const value = fieldValue(args, field);
    const alternatives = [value];
    if (field === "path" && args) {
      for (const selector of [args.anchor, args.start])
        if (args.path === undefined || sameSource(args.path, selector, before))
          alternatives.push(selector);
    }
    if (["start", "anchor"].includes(field) && args && value === undefined)
      alternatives.push(args.path);
    return alternatives.some((candidate) => {
      if (reference.kind?.startsWith("capture:")) {
        const name = reference.kind.slice("capture:".length);
        const captures: unknown[] = [];
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
          }
          if (value === null || typeof value !== "object") return;
          const record = value as Record<string, unknown>;
          if (record.captures && typeof record.captures === "object")
            captures.push((record.captures as Record<string, unknown>)[name]);
          for (const child of Object.values(record)) visit(child);
        };
        visit(prior.result?.structuredContent);
        const lines = resultText(prior)
          .split("\n")
          .map((line) => line.trimStart())
          .filter((line) => line.startsWith("capture " + name + ": "));
        return reuses(candidate, lines.join("\n"), "result", captures.flatMap(valueIds));
      }
      if (reference.kind === "whole-result") {
        if (
          args?.path !== undefined &&
          candidate !== args.path &&
          !sameSource(args.path, candidate, before)
        )
          return false;
        return wholeSearchSelection(candidate, prior);
      }
      if (readItem) return (
        (reference.kind === "anchor" && issuedAnchor(candidate, resultText(prior)) !== undefined) ||
        reuses(candidate, "", reference.kind, valueIds(prior.result?.structuredContent))
      );
      return reuses(
        candidate,
        resultText(prior),
        reference.kind,
        valueIds(prior.result?.structuredContent),
      );
    });
  }
  let furthest = 0;
  const imageFailures = new Map<number, Set<string>>();
  function walk(
    stepIndex: number,
    // A step that another route skips leaves its slot empty; steps reusing it cannot match.
    selected: (
      | {
          event: RunEvent;
          start: number;
          end: number;
          parent?: string;
          call?: string;
          readIndex?: number;
          editorBatch?: { applied: boolean; calls: { id: string }[] };
        }
      | undefined
    )[],
  ): boolean {
    furthest = Math.max(furthest, stepIndex);
    const step = task.steps[stepIndex];
    if (!step) return true;
    if (!routeStepApplies(step, mode)) return walk(stepIndex + 1, [...selected, undefined]);
    // In Codemode, a native text call either fails at once, such as one with a result-bound
    // selector, or is accepted into a batch whose commit fails its parent.
    const acceptedOrFailed = step.error === "direct" && mode === "codemode";
    const dependencies = [
      ...(step.after ?? []),
      ...task.steps
        .slice(0, stepIndex)
        .flatMap((prior, index) =>
          mode === "direct" && prior.tool === "tool_search" && !prior.discovers ? [index] : [],
        ),
    ];
    // Read executes each array source independently. Match each required source against one
    // item, never against the combined array, so separate reuse witnesses stay mandatory.
    const candidates: ((typeof starts)[number] & { readIndex?: number })[] = starts.flatMap(
      (start) => {
        const args = start.event.args;
        return toolSemantics(step.tool) === "read" &&
          start.event.toolName === step.tool &&
          Array.isArray(args?.path) &&
          !Array.isArray(step.args?.path)
          ? args.path.map((path: unknown, readIndex) => ({
              ...start,
              readIndex,
              event: { ...start.event, args: { ...args, path } },
            }))
          : [start];
      },
    );
    for (const start of candidates) {
      const event = start.event;
      const completed = ends.get(event.toolCallId ?? "");
      const item =
        start.readIndex === undefined || !completed
          ? undefined
          : readSourceIssuers({
              tool: step.tool,
              args: startsById.get(event.toolCallId)?.event.args ?? {},
              end: completed.event,
            })[start.readIndex];
      if (start.readIndex !== undefined && !item) continue;
      const end = completed && { ...completed, event: item?.end ?? completed.event };
      if (
        selected.some(
          (prior) =>
            prior?.start === start.index &&
            (prior.readIndex === undefined ||
              start.readIndex === undefined ||
              prior.readIndex === start.readIndex),
        ) ||
        event.toolName !== step.tool ||
        !end ||
        end.index <= start.index ||
        (!acceptedOrFailed && end.event.isError !== Boolean(step.error))
      )
        continue;
      if (dependencies.some((index) => !selected[index] || selected[index].end >= start.index))
        continue;
      const execution = executionParent(start);
      if (!execution) continue;
      if (step.discovers) {
        const loaded = (end.event.result?.details as { loaded?: string[] } | undefined)?.loaded;
        if (execution.parent || !step.discovers.some((name) => loaded?.includes(name))) continue;
      } else if (mode === "codemode" && !codemodeParents.has(execution.parent)) continue;
      // An accepted native text call fails when its parent commits the batch.
      if (
        acceptedOrFailed &&
        !end.event.isError &&
        ends.get(execution.parent ?? "")?.event.isError !== true
      )
        continue;
      if (mode === "direct" && execution.parent) continue;
      if (step.parallelWith !== undefined) {
        const prior = selected[step.parallelWith];
        if (
          mode !== "codemode" ||
          prior === undefined ||
          start.index >= prior.end ||
          end.index <= prior.start ||
          prior.parent !== execution.parent
        )
          continue;
      }
      if (step.sameAssistantWith !== undefined) {
        const prior = selected[step.sameAssistantWith];
        if (
          prior === undefined ||
          (mode === "codemode"
            ? start.index >= prior.end ||
              end.index <= prior.start ||
              prior.parent !== execution.parent
            : !events.some(
                (entry) =>
                  entry.type === "message_end" &&
                  entry.message?.role === "assistant" &&
                  entry.message.content?.some(
                    (block) => block.type === "toolCall" && block.id === execution.call,
                  ) &&
                  entry.message.content.some(
                    (block) => block.type === "toolCall" && block.id === prior.call,
                  ),
              ))
        )
          continue;
      }
      if (
        step.args &&
        !argsMatch(step.tool, step.args, event.args, start.index, start.readIndex !== undefined)
      )
        continue;
      if (
        step.exactText?.some((field) => {
          const value = fieldValue(event.args, field);
          if (typeof value !== "string" || value.length === 0) return true;
          if (
            /^(?:regex:|RESULT#|SEARCH#|CHANGE#|scope-(?:begin|end)-|begin$|end$|<system-result)/u.test(
              value,
            )
          )
            return true;
          if (!/^[0-9A-HJKMNP-TV-Z]{7}(?:\||$)/u.test(value.trim())) return false;
          const source = field.startsWith("target") ? event.args?.target : event.args?.path;
          // Anchor-shaped fixture text is literal unless a completed issuer identifies it as an anchor.
          return (
            selectionIssuers(source, start.index).some((issuer) =>
              issuedAnchor(value.trim(), resultText(issuer.end)),
            ) || !editContext(step.tool, { path: source }, start.index).content?.includes(value)
          );
        })
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
      let editorBatch: { applied: boolean; calls: { id: string }[] } | undefined;
      if (step.editorBatchSize !== undefined) {
        const parent = ends.get(execution.parent ?? "");
        const details = parent?.event.result?.details as
          | {
              editorBatches?: { applied: boolean; calls: { id: string }[] }[];
            }
          | undefined;
        const peerBatch =
          step.sameAssistantWith === undefined
            ? undefined
            : selected[step.sameAssistantWith]?.editorBatch;
        editorBatch = details?.editorBatches?.find(
          (batch) =>
            batch.applied &&
            batch.calls.length === step.editorBatchSize &&
            batch.calls.some((call) => call.id === execution.call) &&
            (peerBatch === undefined || batch === peerBatch),
        );
        if (!parent || parent.index <= end.index || parent.event.isError !== false || !editorBatch)
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
      const references = step.reuse ? (Array.isArray(step.reuse) ? step.reuse : [step.reuse]) : [];
      if (
        references.some((reference) => {
          const prior = selected[reference.from];
          if (!prior || (reference.newParent && prior.parent === execution.parent)) return true;
          // An explicit source is independent of the earlier result, but both calls remain required.
          if (
            reference.explicit !== undefined &&
            (Array.isArray(reference.field) ? reference.field : [reference.field]).some((field) =>
              matches(reference.explicit, fieldValue(event.args, field), field.split(".").at(-1)),
            )
          )
            return false;
          return (
            prior.end >= start.index ||
            !(Array.isArray(reference.field) ? reference.field : [reference.field]).some(
              (field) =>
                argumentReuses(field, event.args, reference, prior.event, start.index, prior.readIndex !== undefined) ||
                passesValue(fieldValue(event.args, field), prior.event),
            )
          );
        })
      )
        continue;
      if (step.image) {
        const minimum = typeof step.image === "number" ? step.image : 1;
        const frames =
          end.event.result?.content?.filter((block) => block.type === "image").length ?? 0;
        if (frames < minimum) {
          const failures = imageFailures.get(stepIndex) ?? new Set<string>();
          failures.add(
            `Step ${stepIndex + 1} (${step.tool}), call ${event.toolCallId}: received ${frames} image frame(s); required at least ${minimum}`,
          );
          imageFailures.set(stepIndex, failures);
          continue;
        }
      }
      if (
        step.scriptResult !== undefined &&
        !matches(step.scriptResult, end.event.result?.structuredContent)
      )
        continue;
      if (
        walk(stepIndex + 1, [
          ...selected,
          {
            event: end.event,
            start: start.index,
            end: end.index,
            readIndex: start.readIndex,
            parent: execution.parent,
            call: execution.call,
            editorBatch,
          },
        ])
      )
        return true;
    }
    return false;
  }
  if (!walk(0, [])) {
    const frameFailures = imageFailures.get(furthest);
    if (frameFailures?.size) reasons.push(...frameFailures);
    else
      reasons.push(
        `Required step ${furthest + 1} (${task.steps[furthest]?.tool}) was not observed with the required arguments, completed result, reuse, and route`,
      );
  }
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
    task.steps.forEach((step, index) => {
      if (step.after?.some((prior) => !Number.isInteger(prior) || prior < 0 || prior >= index))
        problems.push(`${task.id}: step ${index + 1} has an invalid dependency`);
    });
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
