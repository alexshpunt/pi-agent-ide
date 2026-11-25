import { randomUUID } from "node:crypto";
import path from "node:path";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { linearJsonContent, linearJsonSnapshot } from "./json-read.ts";
import { linearErrorRateLimit, safeLinearRateLimitInfo } from "./resource-failure.ts";
import type { LinearSemanticHandler } from "./semantic.ts";
import type { ReadPostReadHandler, ReadToolPluginApi } from "pi-agent-ide/api/read";
import type { ResultTargetStore } from "pi-agent-ide/api/resource";
import { renderPresentedTextDocument } from "pi-agent-ide/api/text";
import { createLinearBodySelectionHandler } from "./text-selection.ts";

export type LinearApiExecutor = (
  workspace: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
  signal?: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>>;

const maximumBytes = 2 * 1024 * 1024;
const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1 },
    variables: { type: "object", additionalProperties: true },
    operationName: { type: "string", minLength: 1, pattern: "^[_A-Za-z][_0-9A-Za-z]*$" },
  },
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(
  code: string,
  source: string,
  effect: "not-applied" | "unknown" = "not-applied",
): never {
  throw new ResourceError(code, source, effect);
}
/** Keep response previews inside the exact shared input selection, including enlarged Read limits. */
export function createLinearApiReadSelection(
  store: ResultTargetStore,
  read: ReadToolPluginApi["read"],
): ReadPostReadHandler {
  const retain = createLinearBodySelectionHandler(
    store,
    read,
    "linear-api",
    (source) => parseLinearApiAddress(source)?.kind === "result",
  );
  return async (context) => {
    const outcome = await retain(context);
    const state = context.state;
    if (
      outcome.kind !== "continue" ||
      !context.sourceTarget ||
      state?.contentKind !== "text" ||
      parseLinearApiAddress(state.source)?.kind !== "result"
    )
      return outcome;
    const ranges = store
      .resolve(context.sourceTarget, context.resolverContext.cwd)
      .targets.filter((target) => target.source === state.source)
      .flatMap((target) => target.ranges);
    return {
      ...outcome,
      transform(result) {
        const retained = outcome.transform?.(result) ?? result;
        const script = retained.script;
        if (retained.isError || script?.kind !== "text" || script.source !== state.source)
          return retained;
        const lines = script.lines.flatMap((line) =>
          ranges.flatMap((range) => {
            if (line.lineNumber < range.start.lineNumber || line.lineNumber > range.end.lineNumber)
              return [];
            const from = line.lineNumber === range.start.lineNumber ? range.start.column : 0;
            const to =
              line.lineNumber === range.end.lineNumber ? range.end.column : line.content.length;
            const ending = line.lineNumber < range.end.lineNumber ? line.lineEnding : "";
            if (to < from || (to === from && !ending)) return [];
            return [{ ...line, content: line.content.slice(from, to), lineEnding: ending }];
          }),
        );
        const content = lines.map((line) => line.content + line.lineEnding).join("");
        const startLine = lines[0]?.lineNumber ?? script.startLine;
        const endLine = lines.at(-1)?.lineNumber ?? startLine;
        return {
          ...retained,
          content: [{ type: "text", text: renderPresentedTextDocument({ ...state.text, lines }) }],
          script: { ...script, content, lines, startLine, endLine },
          details: {
            source: script.source,
            resolvedBy: state.resolvedBy,
            startLine,
            endLine,
            totalLines: script.totalLines,
          },
        };
      },
    };
  };
}
export function parseLinearApiAddress(
  source: string,
): { workspace: string; kind: "request" | "result" | "index" } | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return;
  }
  const workspace = url.hostname;
  if (!/^[A-Za-z0-9_-]+$/u.test(workspace)) return;
  const root = `linear://${workspace}/api`;
  if (source === root) return { workspace, kind: "index" };
  if (source === root + "/graphql") return { workspace, kind: "request" };
  if (
    source.startsWith(root + "/results/") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      source.slice((root + "/results/").length),
    )
  )
    return { workspace, kind: "result" };
}
function request(source: string, content: string): Record<string, unknown> {
  if (Buffer.byteLength(content, "utf8") > maximumBytes) fail("LINEAR_CONTENT_TOO_LARGE", source);
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    fail("LINEAR_GRAPHQL_INPUT_INVALID", source);
  }
  if (
    !record(input) ||
    Object.keys(input).some((key) => !["query", "variables", "operationName"].includes(key)) ||
    typeof input.query !== "string" ||
    !input.query.trim() ||
    (input.variables !== undefined && !record(input.variables)) ||
    (input.operationName !== undefined &&
      (typeof input.operationName !== "string" ||
        !/^[_A-Za-z][_0-9A-Za-z]*$/u.test(input.operationName)))
  )
    fail("LINEAR_GRAPHQL_INPUT_INVALID", source);
  return input;
}
function checkedReceipt(
  value: unknown,
  workspace: string,
  source: string,
): Record<string, unknown> {
  if (
    !record(value) ||
    value.workspace !== workspace ||
    !["query", "mutation"].includes(String(value.operationType)) ||
    !(
      value.status === null ||
      (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599)
    ) ||
    typeof value.ok !== "boolean" ||
    !["applied", "not-applied", "unknown"].includes(String(value.effect)) ||
    !["success", "partial", "error", "unknown"].includes(String(value.outcome)) ||
    (value.ok &&
      (value.outcome !== "success" ||
        value.effect === "unknown" ||
        value.status === null ||
        Number(value.status) < 200 ||
        Number(value.status) >= 300 ||
        value.error !== undefined ||
        (Array.isArray(value.errors) && value.errors.length > 0))) ||
    (!value.ok && value.outcome === "success") ||
    (value.errors !== undefined && !Array.isArray(value.errors))
  )
    fail("LINEAR_GRAPHQL_INVALID_RECEIPT", source, "unknown");
  return value;
}

/** Session-local response snapshots never fetch or widen a selected response's scope. */
export function createLinearApi(
  execute: LinearApiExecutor,
  options: {
    readonly maximumResults?: number;
    readonly maximumStoredBytes?: number;
  } = {},
) {
  const maximumResults = options.maximumResults ?? 16;
  const maximumStoredBytes = options.maximumStoredBytes ?? 32 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 16 ||
    !Number.isSafeInteger(maximumStoredBytes) ||
    maximumStoredBytes < maximumBytes ||
    maximumStoredBytes > 32 * 1024 * 1024
  )
    throw new Error("LINEAR_GRAPHQL_INVALID_CACHE_LIMIT");
  const snapshots = new Map<string, { cwd: string; content: string; bytes: number }>();
  let bytes = 0;
  let generation = 0;
  const clear = () => {
    generation++;
    snapshots.clear();
    bytes = 0;
  };
  function readSnapshot(source: string, cwd: string) {
    const selected = parseLinearApiAddress(source);
    if (!selected) fail("LINEAR_GRAPHQL_RESOURCE_UNSUPPORTED", source);
    if (selected.kind === "index")
      return linearJsonSnapshot({
        source,
        graphql: `linear://${selected.workspace}/api/graphql`,
        guide: "docs:linear-api",
      });
    if (selected.kind === "request")
      return linearJsonSnapshot({
        source,
        tool: "write",
        mode: "YOLO",
        notice:
          "Raw GraphQL has no per-request confirmation and can bypass typed-route gates. Ask before destructive work. Never replay an uncertain mutation.",
        limits: { requestBytes: maximumBytes, responseBytes: maximumBytes },
        input: requestSchema,
      });
    const saved = snapshots.get(source);
    if (!saved || saved.cwd !== path.resolve(cwd))
      fail("LINEAR_GRAPHQL_RESULT_UNAVAILABLE", source);
    return linearJsonSnapshot(
      JSON.parse(saved.content),
      saved.content,
      "Coverage: this response only. Another page requires an explicit GraphQL request.",
    );
  }
  async function submit(source: string, content: string, cwd: string, signal?: AbortSignal) {
    const selected = parseLinearApiAddress(source);
    if (selected?.kind !== "request") fail("LINEAR_GRAPHQL_WRITE_REQUIRED", source);
    const input = request(source, content);
    signal?.throwIfAborted();
    const observedGeneration = generation;
    let receipt: Record<string, unknown>;
    try {
      receipt = checkedReceipt(
        await execute(selected.workspace, input, cwd, signal),
        selected.workspace,
        source,
      );
    } catch (error) {
      if (error instanceof ResourceError && error.effect === "not-applied") throw error;
      const rateLimit = linearErrorRateLimit(error);
      const effect =
        error instanceof ResourceError && error.effect === "applied" ? "applied" : "unknown";
      receipt = {
        workspace: selected.workspace,
        operationType: "unknown",
        status: null,
        effect,
        ok: false,
        outcome: effect === "applied" ? "error" : "unknown",
        error: error instanceof ResourceError ? error.code : "LINEAR_GRAPHQL_TRANSPORT_UNKNOWN",
        ...(rateLimit ? { rateLimit } : {}),
      };
    }
    if (generation !== observedGeneration)
      throw new ResourceError(
        "LINEAR_OPERATION_CONNECTION_CHANGED",
        source,
        receipt.effect === "applied"
          ? "applied"
          : receipt.effect === "not-applied"
            ? "not-applied"
            : "unknown",
      );
    const canonical = `linear://${selected.workspace}/api/results/${randomUUID()}`;
    let value: Record<string, unknown> = { ...receipt, source: canonical, request: source };
    let compact = JSON.stringify(value);
    if (Buffer.byteLength(compact, "utf8") > maximumBytes) {
      value = {
        workspace: selected.workspace,
        operationType: receipt.operationType,
        status: receipt.status,
        effect: receipt.effect,
        ok: false,
        outcome: "error",
        error: "LINEAR_GRAPHQL_RESPONSE_TOO_LARGE",
        source: canonical,
        request: source,
      };
      compact = JSON.stringify(value);
    }
    const pretty = JSON.stringify(value, null, 2);
    const stored = Buffer.byteLength(pretty, "utf8") <= maximumBytes ? pretty : compact;
    const size = Buffer.byteLength(stored, "utf8");
    snapshots.set(canonical, { cwd: path.resolve(cwd), content: stored, bytes: size });
    bytes += size;
    while (snapshots.size > maximumResults || bytes > maximumStoredBytes) {
      const oldest = snapshots.entries().next();
      if (oldest.done) break;
      const [key, snapshot] = oldest.value;
      bytes -= snapshot.bytes;
      snapshots.delete(key);
    }
    const retained = JSON.parse(compact) as Record<string, unknown>;
    const fields = [
      "workspace",
      "operationType",
      "operationName",
      "status",
      "effect",
      "ok",
      "outcome",
    ];
    const rateLimit = safeLinearRateLimitInfo(retained.rateLimit);
    const data: Record<string, unknown> = {
      ...Object.fromEntries(
        fields.filter((key) => Object.hasOwn(retained, key)).map((key) => [key, retained[key]]),
      ),
      source: canonical,
      request: source,
      kind: "linear-graphql",
      errorCount: Array.isArray(retained.errors) ? retained.errors.length : 0,
      ...(typeof retained.error === "string" && /^LINEAR_[A-Z_]+$/u.test(retained.error)
        ? { error: retained.error }
        : {}),
      ...(rateLimit ? { rateLimit } : {}),
    };
    return {
      source: canonical,
      summary: `Linear GraphQL ${String(data.operationType)}: ${String(data.outcome)}.\nHTTP: ${String(data.status)}; effect: ${String(data.effect)}.\nRead: ${canonical}${data.effect === "unknown" ? "\nDo not replay this request." : ""}`,
      data,
      script: data,
    };
  }
  const write: LinearSemanticHandler = {
    matches: (value) =>
      record(value) &&
      typeof value.path === "string" &&
      parseLinearApiAddress(value.path)?.kind === "request",
    async execute(context, value) {
      if (!record(value) || typeof value.path !== "string" || typeof value.content !== "string")
        fail("LINEAR_GRAPHQL_INPUT_INVALID", "linear://");
      return submit(value.path, value.content, context.cwd, context.signal);
    },
  };
  const resolver: ResourceResolver = {
    id: "linear-api",
    async tryResolve(source, context) {
      if (!parseLinearApiAddress(source)) return { kind: "not-handled" };
      try {
        const snapshot = readSnapshot(source, context.cwd);
        return {
          kind: "resolved",
          resource: {
            source,
            sourceBytes: Buffer.from(snapshot.content),
            read: async () => linearJsonContent(snapshot),
          },
        };
      } catch (error) {
        if (error instanceof ResourceError) return { kind: "failed", error };
        throw error;
      }
    },
  };
  return {
    read: async (source: string, cwd: string) => readSnapshot(source, cwd).content,
    submit,
    write,
    resolver,
    clear,
    ownsAction: (source: string) => parseLinearApiAddress(source)?.kind === "request",
  };
}
