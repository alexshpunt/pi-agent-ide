import type { RunLimits } from "run";
import { ApplyQueue } from "#src/core/apply/queue.js";

/** Read-only IDE operations plus the private transactional editor bridge. */
export const defaultApplyOperations = [
  "read",
  "search",
  "diff",
  "editorOpen",
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
      source: `${guestBindings(enabledOperations)}\n${source}\n__finishApplyScript();`,
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
  return `const { ${readOperations.join(", ")}, open, createFile, deleteFile, copyFile, moveFile, apply, result, __finishApplyScript } = (() => {
    const origins = new WeakMap();
    const invoke = (name, args) => {
      const response = __apply[name](args);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.value !== null && typeof response.value === "object") origins.set(response.value, response.id);
      return response.value;
    };
    let generation = 0;
    let snapshots = new Map();
    let operations = [];
    const assertCurrent = (document) => {
      if (document.generation !== generation) throw Object.assign(new Error("Editor handle belongs to a committed transaction"), {code: "STALE_EDITOR"});
    };
    const selection = (document, from, to) => Object.freeze({document: document.id, from, to, text: document.content.slice(from, to)});
    const occurrences = (content, needle) => {
      if (typeof needle !== "string" || needle.length === 0) throw new Error("Find text must be non-empty");
      const found = [];
      for (let from = content.indexOf(needle); from >= 0; from = content.indexOf(needle, from + needle.length)) found.push(from);
      return found;
    };
    const unique = (document, needle) => {
      const found = occurrences(document.content, needle);
      if (found.length !== 1) throw Object.assign(new Error("Expected exactly one match, found " + found.length), {code: found.length === 0 ? "NOT_FOUND" : "AMBIGUOUS_MATCH"});
      return selection(document, found[0], found[0] + needle.length);
    };
    const makeDocument = (snapshot) => {
      const document = {id: snapshot.id, source: snapshot.source, content: snapshot.content, lines: snapshot.lines, generation};
      const api = {
        source: document.source,
        content: document.content,
        lines: document.lines,
        find: (text) => { assertCurrent(document); return unique(document, text); },
        findAll: (text) => { assertCurrent(document); return occurrences(document.content, text).map((from) => selection(document, from, from + text.length)); },
        between: (start, end, options = {}) => {
          assertCurrent(document);
          const first = unique(document, start);
          const tail = document.content.slice(first.to);
          const ends = occurrences(tail, end);
          if (ends.length !== 1) throw Object.assign(new Error("Expected exactly one end marker after start, found " + ends.length), {code: ends.length === 0 ? "NOT_FOUND" : "AMBIGUOUS_MATCH"});
          const endFrom = first.to + ends[0];
          return selection(document, options.inside === true ? first.to : first.from, options.inside === true ? endFrom : endFrom + end.length);
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
          return selected;
        },
        line: (first, last = first) => {
          assertCurrent(document);
          if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) throw new RangeError("Invalid line range");
          const starts = [0];
          for (let index = 0; index < document.content.length; index += 1) if (document.content[index] === "\\n") starts.push(index + 1);
          if (last > starts.length) throw new RangeError("Line range is outside document");
          return selection(document, starts[first - 1], starts[last] === undefined ? document.content.length : starts[last]);
        },
        replace: (selected, text) => { assertCurrent(document); operations.push({kind: "replace", selection: selected, text: String(text)}); },
        remove: (selected) => { assertCurrent(document); operations.push({kind: "replace", selection: selected, text: ""}); },
        insertBefore: (selected, text) => { assertCurrent(document); operations.push({kind: "replace", selection: selection(document, selected.from, selected.from), text: String(text)}); },
        insertAfter: (selected, text) => { assertCurrent(document); operations.push({kind: "replace", selection: selection(document, selected.to, selected.to), text: String(text)}); },
        replaceAll: (text, replacement) => { assertCurrent(document); const found = api.findAll(text); if (found.length === 0) throw Object.assign(new Error("No matches"), {code: "NOT_FOUND"}); for (const selected of found) api.replace(selected, replacement); return found.length; },
      };
      return Object.freeze(api);
    };
    return {
      ${readOperations.map((name) => `${name}: (args) => invoke(${JSON.stringify(name)}, args)`).join(",\n")},
      open: (path) => { const snapshot = invoke("editorOpen", typeof path === "string" ? {path} : path); snapshots.set(snapshot.id, snapshot); return makeDocument(snapshot); },
      createFile: (path, content) => operations.push({kind: "create", path, content: String(content)}),
      deleteFile: (path) => operations.push({kind: "delete", path}),
      copyFile: (path, target, options = {}) => operations.push({kind: "copy", path, target, overwrite: options.overwrite === true}),
      moveFile: (path, target, options = {}) => operations.push({kind: "move", path, target, overwrite: options.overwrite === true}),
      apply: () => {
        const value = invoke("editorApply", {snapshots: [...snapshots.values()].map(({id, source, content}) => ({id, source, content})), operations});
        generation += 1; snapshots = new Map(); operations = []; return value;
      },
      result: (value) => __apply.result(value, value !== null && typeof value === "object" ? origins.get(value) : undefined),
      __finishApplyScript: () => { if (operations.length > 0) __apply.result({kind: "uncommitted-transaction", staged: operations.length, message: "Staged changes were not applied; call apply()."}); },
    };
  })();`;
}
