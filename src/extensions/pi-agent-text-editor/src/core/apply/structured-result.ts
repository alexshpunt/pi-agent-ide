import { Type } from "typebox";
import {
  resultError,
  resultErrorSchema,
  structuredResultSchema,
  withStructuredResult,
  type ResultError,
} from "pi-agent-resource";
import { readDataSchema, structuredRead } from "pi-agent-read/api/tools/read";
import { searchDataSchema } from "pi-agent-search/api/search";
import { mutationDataSchema } from "#src/core/structured-result.js";
import { diffDataSchema, isDiffOutcome } from "#src/core/diff-tool.js";
import type { ApplyResults } from "./results.js";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
const operationSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Union([Type.Literal("read"), Type.Literal("mutation")]),
    fullResultBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    fullResult: Type.Optional(Type.String()),
    status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("partial")]),
    data: Type.Optional(
      Type.Union([
        readDataSchema,
        searchDataSchema,
        mutationDataSchema,
        diffDataSchema,
        Type.Object({ source: Type.String() }, { additionalProperties: false }),
      ]),
    ),
    errors: Type.Array(resultErrorSchema),
  },
  { additionalProperties: false },
);
export const applyDataSchema = Type.Object(
  {
    operations: Type.Array(operationSchema),
    files: Type.Array(Type.String()),
    transactions: Type.Array(Type.String()),
    values: Type.Array(Type.Unknown()),
    truncated: Type.Boolean(),
    fullResult: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const applyOutputSchema = structuredResultSchema(applyDataSchema);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Project the host ledger, retaining committed receipts while omitting full source snapshots. */
export async function structuredApply<D>(
  result: AgentToolResult<D>,
  results: ApplyResults,
  read: ReadPluginApi,
  transactions: readonly string[],
  error?: unknown,
) {
  const errors: ResultError[] = error === undefined ? [] : [resultError(error, "APPLY_FAILED")];
  const operations = [];
  let applied = false;
  for (const entry of results.operations()) {
    const value = record(entry.value) ? entry.value : {};
    let data: unknown;
    const failures: ResultError[] = [];
    if (entry.kind === "mutation") {
      const effect =
        value.effect === "applied" || value.effect === "not-applied" || value.effect === "unknown"
          ? value.effect
          : "unknown";
      applied ||= effect === "applied";
      const operationErrors = Array.isArray(value.errors) ? value.errors : [];
      for (const error of operationErrors)
        if (record(error))
          failures.push({
            code: typeof error.code === "string" ? error.code : "MUTATION_FAILED",
            message: typeof error.message === "string" ? error.message : "Mutation failed",
            ...(typeof error.source === "string" ? { source: error.source } : {}),
          });
      const perOperation = Array.isArray(value.operations) ? value.operations.filter(record) : [];
      if (
        value.ok === false &&
        failures.length === 0 &&
        (perOperation.length === 0 ||
          perOperation.some(
            (operation) => operation.status !== "applied" && operation.status !== "warning",
          ))
      )
        failures.push(resultError("Mutation did not complete", "MUTATION_FAILED"));
      if (record(value.error))
        failures.push(
          resultError(
            value.error.message,
            typeof value.error.code === "string" ? value.error.code : "MUTATION_FAILED",
          ),
        );
      data = {
        operation: typeof value.operation === "string" ? value.operation : "apply",
        effect,
        files: Array.isArray(value.files)
          ? value.files
              .filter(record)
              .filter((file) => typeof file.source === "string")
              .map((file) => ({ source: file.source, effect: "applied" }))
          : [],
        operations: perOperation.filter(record).map((operation) => ({
          id: `${entry.id}:${String(operation.index)}`,
          operation: String(operation.kind),
          effect: operation.effect,
          status:
            operation.status === "applied"
              ? "success"
              : operation.status === "warning"
                ? "warning"
                : operation.status === "unknown"
                  ? "unknown"
                  : "error",
          sources: Array.isArray(operation.resources) ? operation.resources : [],
          ...(record(operation.warning)
            ? { warnings: [resultError(operation.warning.message, String(operation.warning.code))] }
            : {}),
          errors: record(operation.error)
            ? [resultError(operation.error.message, String(operation.error.code))]
            : [],
        })),
        ...(typeof value.transaction === "string" ? { transaction: value.transaction } : {}),
      };
    } else if (isDiffOutcome(value)) {
      const diff = truncateHead(value.diff);
      const fullResult = diff.truncated ? await read.saveTemporary(value.diff) : undefined;
      data = {
        kind: "diff",
        equal: value.equal,
        before: { source: value.before.source, sources: value.before.sources },
        after: { source: value.after.source, sources: value.after.sources },
        stats: value.stats,
        diff: diff.content,
        truncated: diff.truncated,
        ...(fullResult === undefined ? {} : { fullResult }),
      };
    } else if (entry.presentation?.script !== undefined || entry.presentation?.isError) {
      const projected = structuredRead(entry.presentation);
      const outcome = projected.structuredContent;
      if (record(outcome)) {
        data = outcome.data;
        if (Array.isArray(outcome.errors))
          for (const error of outcome.errors)
            if (record(error)) failures.push(resultError(error.message, String(error.code)));
      }
    } else if (record(value.structured)) {
      data = value.structured.data;
      if (Array.isArray(value.structured.errors))
        for (const error of value.structured.errors)
          if (record(error)) failures.push(resultError(error.message, String(error.code)));
    } else if (typeof value.source === "string") {
      data = { source: value.source };
    } else if (value.ok === false) {
      failures.push(
        resultError(
          record(value.error) ? value.error.message : "Operation failed",
          "APPLY_OPERATION_FAILED",
        ),
      );
    } else {
      failures.push(resultError("Operation did not report structured data", "UNKNOWN_RESULT"));
    }
    errors.push(...failures);
    operations.push({
      id: entry.id,
      kind: entry.kind,
      ...(typeof value.fullResult === "string" ? { fullResult: value.fullResult } : {}),
      ...(typeof value.fullResultBytes === "number"
        ? { fullResultBytes: value.fullResultBytes }
        : {}),
      status:
        failures.length === 0
          ? "success"
          : entry.kind === "mutation" && value.effect === "applied"
            ? "partial"
            : "error",
      ...(data === undefined ? {} : { data }),
      errors: failures,
    });
  }
  const selected = results.select();
  const status =
    errors.length === 0
      ? "success"
      : applied || operations.some((operation) => operation.status === "success")
        ? "partial"
        : "error";
  const data = {
    operations,
    files: selected.files.map((file) => file.source),
    transactions: [...transactions],
    values: selected.explicit.filter((entry) => entry.kind === "value").map((entry) => entry.value),
    truncated: false,
  };
  if (
    results.mutationValues().some((value) => record(value) && value.truncated === true) ||
    Buffer.byteLength(JSON.stringify(data)) > 512 * 1024
  ) {
    const fullResult = await read.saveTemporary(JSON.stringify(data, null, 2));
    const oversized = Buffer.byteLength(JSON.stringify(data)) > 512 * 1024;
    const withoutReads = operations.map((operation) => {
      if (!oversized || operation.kind === "mutation") return operation;
      const { data: _detail, ...summary } = operation;
      return summary;
    });
    const mutationsOversized = Buffer.byteLength(JSON.stringify(withoutReads)) > 512 * 1024;
    const summaries = withoutReads.map((operation) => {
      if (!mutationsOversized || !("data" in operation)) return operation;
      const { data: detail, ...summary } = operation;
      const value = record(detail) ? detail : undefined;
      return {
        ...summary,
        ...(operation.kind === "mutation" && value !== undefined
          ? {
              data: {
                operation: value.operation,
                effect: value.effect,
                files: value.files,
                ...(typeof value.transaction === "string"
                  ? { transaction: value.transaction }
                  : {}),
              },
            }
          : {}),
      };
    });
    return withStructuredResult(result, applyDataSchema, {
      status,
      data: {
        operations: summaries,
        files: data.files,
        transactions: data.transactions,
        values: [],
        truncated: true,
        fullResult,
      },
      errors,
    });
  }
  return withStructuredResult(result, applyDataSchema, {
    status,
    data,
    errors,
  });
}
