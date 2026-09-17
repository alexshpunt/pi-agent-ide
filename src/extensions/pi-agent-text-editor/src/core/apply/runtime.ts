import type { RunLimits } from "run";
import { ApplyQueue } from "#src/core/apply/queue.js";

/** Read-only IDE operations plus the private transactional editor bridge. */
export const defaultApplyOperations = [
  "read",
  "search",
  "diff",
  "editorOpen",
  "editorResolve",
  "editorApply",
] as const;
export type ApplyOperation = (typeof defaultApplyOperations)[number];

// Node timers use signed 32-bit delays. This is effectively unbounded for an agent turn while
// preserving Run's finite sandbox deadline and explicit limits used by focused tests.
const APPLY_EXECUTION_TIMEOUT_MS = 2_147_483_647;

/** Return the fixed Apply capability set. Kept as a function for callers that build prompts. */
export function getApplyOperations(): readonly ApplyOperation[] {
  return defaultApplyOperations;
}

/** The host records outcomes before returning them across the guest bridge. */
export interface ApplyRuntimeHost {
  execute(
    operation: ApplyOperation,
    arguments_: unknown,
    signal: AbortSignal,
    id: string,
  ): Promise<unknown>;
  result(value: unknown, operationId?: string): Promise<void>;
}

/** Runs a fresh composition and drains host work on success, failure, or cancellation. */
export async function executeApplySource(
  source: string,
  host: ApplyRuntimeHost,
  signal?: AbortSignal,
  limits?: RunLimits,
  enabledOperations: readonly ApplyOperation[] = defaultApplyOperations,
): Promise<void> {
  const { createRunner, getHostFunctionContext } = await import("run");
  const queue = new ApplyQueue();
  const operations = Object.fromEntries(
    enabledOperations.map((operation) => [
      operation,
      (arguments_: unknown) => {
        const context = getHostFunctionContext();
        return queue.submit(async () => {
          context.abortSignal.throwIfAborted();
          try {
            return {
              ok: true,
              value: await host.execute(
                operation,
                arguments_,
                context.abortSignal,
                context.requestId,
              ),
              id: context.requestId,
            };
          } catch (error) {
            return { ok: false, error: serializeApplyError(error) };
          }
        });
      },
    ]),
  );
  try {
    const runner = createRunner({
      syncHostFunctions: {
        __apply: {
          ...operations,
          result: (value: unknown, operationId?: string) =>
            queue.submit(() => host.result(value, operationId)),
        },
      },
    });
    await runner.run({
      source: `${guestBindings(enabledOperations)}\nawait (async () => {\n${source}\n})();\n__finishApplyScript();`,
      abortSignal: signal,
      limits: { ...limits, timeoutMs: limits?.timeoutMs ?? APPLY_EXECUTION_TIMEOUT_MS },
    });
  } finally {
    await queue.close();
  }
}

/** Preserves operation error fields without sending host Error instances across the bridge. */
export function serializeApplyError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (!(error instanceof Error)) return { code: "OPERATION_FAILED", message: String(error) };
  const runtimeCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    code:
      runtimeCode === "RUN_USER_SOURCE_ERROR"
        ? applyGuestErrorCode(error.message)
        : (runtimeCode ?? "OPERATION_FAILED"),
    message: error.message,
    ...("details" in error ? { details: error.details } : {}),
  };
}

function applyGuestErrorCode(message: string): string {
  if (/Expected exactly one (?:match|end marker)/u.test(message))
    return message.endsWith("found 0") ? "NOT_FOUND" : "AMBIGUOUS_MATCH";
  if (message === "No matches") return "NOT_FOUND";
  if (message === "Search match is stale") return "STALE_SELECTION";
  if (message === "Editor handle belongs to a committed transaction") return "STALE_EDITOR";
  if (/^(?:Invalid line range|Line range is outside document)$/u.test(message))
    return "INVALID_SELECTION";
  return "RUN_USER_SOURCE_ERROR";
}
function guestBindings(enabledOperations: readonly ApplyOperation[]): string {
  const readOperations = enabledOperations.filter(
    (name) => name === "read" || name === "search" || name === "diff",
  );
  return `const { ${readOperations.join(", ")}, open, createFile, deleteFile, copyFile, moveFile, copy, move, flush, result, __finishApplyScript } = (() => {
    const origins = new WeakMap();
    const invoke = (name, args) => {
      const response = __apply[name](args);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.value !== null && typeof response.value === "object") origins.set(response.value, response.id);
      return response.value;
    };
    let snapshots = new Map();
    let operations = [];
    const assertCurrent = (document) => {
      if (!snapshots.has(document.id)) throw Object.assign(new Error("Editor handle belongs to an unavailable snapshot"), {code: "STALE_EDITOR"});
    };
    const selection = (document, from, to, linewise = false) => Object.freeze({document: document.id, from, to, text: document.content.slice(from, to), ...(linewise && {linewise: true})});
    const selectionSet = (document, ranges, provenance) => {
      const set = ranges.map(({from, to, linewise}) => selection(document, from, to, linewise === true));
      Object.defineProperties(set, {document: {value: document.id}, generation: {value: document.generation}, provenance: {value: provenance}, text: {value: set.map((item) => item.text).join("")}});
      return Object.freeze(set);
    };
    const occurrences = (content, needle) => {
      if (typeof needle !== "string" || needle.length === 0) throw new Error("Find text must be non-empty");
      const found = [];
      for (let from = content.indexOf(needle); from >= 0; from = content.indexOf(needle, from + needle.length)) found.push(from);
      return found;
    };
    const targetSet = (document, target) => {
      if (typeof target !== "string") return target;
      const resolved = invoke("editorResolve", {snapshot: {id: document.id, source: document.source, content: document.content}, query: target});
      return selectionSet(document, resolved.selections, {kind: "exact", query: target, warning: resolved.warning});
    };
    const stage = (document, target, text, edge) => {
      const selected = targetSet(document, target);
      if (!Array.isArray(selected) || selected.document !== document.id) throw new Error("SelectionSet belongs to another file");
      if (selected.generation !== document.generation) throw Object.assign(new Error("SelectionSet belongs to a stale snapshot"), {code:"STALE_SELECTION"});
      if (selected.length === 0) { operations.push({kind: "warning", document: document.id, query: selected.provenance?.query, warning: selected.provenance?.warning}); return; }
      for (const range of selected) {
        const point = edge === "before" ? range.from : edge === "after" ? range.to : undefined;
        let insert = text;
        if (point !== undefined && range.linewise === true) {
          const ending = /(?:\\r\\n|\\r|\\n)$/u.exec(range.text)?.[0];
          const separator = ending ?? (document.content.includes("\\r\\n") ? "\\r\\n" : "\\n");
          if (edge === "after" && ending === undefined) insert = separator + insert;
          else if (!/(?:\\r\\n|\\r|\\n)$/u.test(insert)) insert += separator;
        }
        operations.push({kind: "replace", selection: point === undefined ? range : selection(document, point, point), text: insert});
      }
    };
    const stageTransfer = (kind, source, destination) => {
      for (const set of [source, destination]) {
        const document = snapshots.get(set?.document);
        if (!Array.isArray(set) || document === undefined || set.generation !== document.generation) throw Object.assign(new Error("SelectionSet belongs to a stale or unopened snapshot"), {code:"STALE_SELECTION"});
      }
      const empty = source.length === 0 ? source : destination.length === 0 ? destination : undefined;
      if (empty !== undefined) { operations.push({kind:"warning", document:empty.document, query:empty.provenance?.query, warning:empty.provenance?.warning}); return; }
      operations.push({kind, sources:[...source], destinations:[...destination], text:source.map((item) => item.text).join("")});
    };
    const makeDocument = (snapshot) => {
      const document = {id: snapshot.id, source: snapshot.source, content: snapshot.content, lines: snapshot.lines, generation: 0};
      snapshots.set(document.id, document);
      const api = {
        get source() { return document.source; },
        get content() { return document.content; },
        get lines() { return document.lines; },
        find: (text) => { assertCurrent(document); const ranges = occurrences(document.content, text).map((from) => ({from, to: from + text.length})); if (ranges.length > 0) return selectionSet(document, ranges, {kind: "exact", query: text}); const resolved = invoke("editorResolve", {snapshot: {id: document.id, source: document.source, content: document.content}, query: text}); return selectionSet(document, [], {kind: "exact", query: text, warning: resolved.warning}); },
        between: (start, end, options = {}) => {
          assertCurrent(document);
          const ranges = [];
          let cursor = 0;
          while (cursor <= document.content.length) {
            const from = document.content.indexOf(start, cursor);
            if (from < 0) break;
            const endFrom = document.content.indexOf(end, from + start.length);
            if (endFrom < 0) break;
            ranges.push({from: options.inside === true ? from + start.length : from, to: options.inside === true ? endFrom : endFrom + end.length});
            cursor = endFrom + end.length;
          }
          return selectionSet(document, ranges, {kind: "between", start, end});
        },
select: (match) => {
          assertCurrent(document);
          const candidate = match?.selection ?? match;
          if (!candidate || typeof candidate !== "object") throw new Error("select() requires a search match");
          if (candidate.source && candidate.source !== document.source) throw new Error("Search match belongs to another file");
          const starts = [0];
          for (let index = 0; index < document.content.length; index += 1) if (document.content[index] === "\\n") starts.push(index + 1);
          const startLine = candidate.lineNumber;
          const endLine = candidate.endLineNumber ?? startLine;
          if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) throw new Error("Search match has no text range");
          const from = starts[startLine - 1] + candidate.startColumn;
          const to = starts[endLine - 1] + candidate.endColumn;
          const selected = selection(document, from, to);
          if (typeof candidate.matchedText === "string" && selected.text !== candidate.matchedText) throw Object.assign(new Error("Search match is stale"), {code: "STALE_SELECTION"});
          return selectionSet(document, [selected]);
        },
        line: (first, last = first) => {
          assertCurrent(document);
          if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) throw new RangeError("Invalid line range");
          const starts = [0];
          for (let index = 0; index < document.content.length; index += 1) if (document.content[index] === "\\n") starts.push(index + 1);
          if (last > starts.length) throw new RangeError("Line range is outside document");
          return selectionSet(document, [{from: starts[first - 1], to: starts[last] === undefined ? document.content.length : starts[last]}]);
        },
        replace: (target, text) => { assertCurrent(document); stage(document, target, String(text)); },
        remove: (target) => { assertCurrent(document); stage(document, target, ""); },
        insertBefore: (target, text) => { assertCurrent(document); stage(document, target, String(text), "before"); },
        insertAfter: (target, text) => { assertCurrent(document); stage(document, target, String(text), "after"); },
      };
      return Object.freeze(api);
    };
    const api = {
      ${readOperations.map((name) => `${name}: (args) => invoke(${JSON.stringify(name)}, args)`).join(",\n")},
      open: (path) => makeDocument(invoke("editorOpen", typeof path === "string" ? {path} : path)),
      createFile: (path, content) => operations.push({kind: "create", path, content: String(content)}),
      deleteFile: (path) => operations.push({kind: "delete", path}),
      copyFile: (path, target, options = {}) => operations.push({kind: "copy", path, target, overwrite: options.overwrite === true}),
      moveFile: (path, target, options = {}) => operations.push({kind: "move", path, target, overwrite: options.overwrite === true}),
      copy: (source, destination) => stageTransfer("text-copy", source, destination),
      move: (source, destination) => stageTransfer("text-move", source, destination),
      flush: () => {
        if (operations.length === 0) return undefined;
        const pending = operations;
        operations = [];
        const value = invoke("editorApply", {snapshots: [...snapshots.values()].map(({id, source, content}) => ({id, source, content})), operations: pending});
        for (const refreshed of value?.snapshots ?? []) {
          const document = snapshots.get(refreshed.id);
          if (document !== undefined && refreshed.unavailable === true) snapshots.delete(refreshed.id);
          else if (document !== undefined) {
            document.source = refreshed.source;
            document.content = refreshed.content;
            document.lines = refreshed.lines;
            document.generation += 1;
          }
        }
        return value;
      },
      result: (value) => __apply.result(value, value !== null && typeof value === "object" ? origins.get(value) : undefined),
      __finishApplyScript: () => { if (operations.length > 0) return api.flush(); },
    };
    return api;
  })();`;
}
