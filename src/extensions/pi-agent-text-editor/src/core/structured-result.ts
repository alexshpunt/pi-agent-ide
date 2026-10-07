import { Type, type Static } from "typebox";
import {
  resultError,
  structuredResultSchema,
  withStructuredResult,
  type StructuredResult,
  type ResultError,
} from "pi-agent-resource";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import type { TextEditCompletion } from "#src/api/edit-completion.js";

const effect = Type.Union([
  Type.Literal("pending"),
  Type.Literal("applied"),
  Type.Literal("not-applied"),
  Type.Literal("unknown"),
]);
const file = Type.Object(
  {
    source: Type.String(),
    effect,
    state: Type.Optional(
      Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("unknown")]),
    ),
  },
  { additionalProperties: false },
);
const receipt = { effect, files: Type.Array(file) };

/** Validate one file tool's result. Recovery, rendering and resource actions stay in details. */
export function mutationDataSchema(operation: string) {
  return Type.Object(
    {
      operation: Type.Literal(operation),
      ...receipt,
      operationId: Type.Optional(Type.String()),
      ...(operation === "delete"
        ? {}
        : {
            target: Type.Optional(Type.String()),
            targetUnavailable: Type.Optional(Type.String()),
          }),
    },
    { additionalProperties: false },
  );
}
/** Internal validation schema for a single tool, not an agent-facing return declaration. */
export function mutationResultSchema(operation: string) {
  return structuredResultSchema(mutationDataSchema(operation));
}
/** Observed file and operation effects retained on the parent native script. */
export interface BatchMutationData {
  operation: "batch";
  effect: MutationData["effect"];
  files: MutationData["files"];
  operations: {
    id: string;
    operation: string;
    effect: MutationData["effect"];
    errors: ResultError[];
  }[];
}
/** Small internal receipt used to collect observed file effects. */
export interface MutationData {
  operation: string;
  effect: Static<typeof effect>;
  files: Static<typeof file>[];
  operationId?: string;
  target?: string;
  targetUnavailable?: string;
}
type MutationFile = MutationData["files"][number];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/** Use observed completion events for effects; errors do not prove a rollback. */
export function mutationOutcome(
  result: AgentToolResult<FileMutationBatchResult>,
  operation: string,
  completions: readonly TextEditCompletion[] = [],
): StructuredResult<MutationData> {
  const details = result.details;
  const detailRecord: Record<string, unknown> = record(details) ? details : {};
  const native =
    record(details) && record(details.nativeEditBatch) ? details.nativeEditBatch : undefined;
  if (native?.state === "accepted")
    return {
      status: "success",
      errors: [],
      data: {
        operation,
        effect: "pending",
        ...(operation !== "delete" && typeof details.metadata?.resultTarget === "string"
          ? { target: details.metadata.resultTarget }
          : {}),
        files:
          typeof detailRecord.source === "string"
            ? [{ source: detailRecord.source, effect: "pending" }]
            : [],
      },
    };
  const observed = new Set(completions.map((completion) => completion.resourceSource));
  const errors: ResultError[] = [];
  const files: MutationFile[] = [];
  const results = details.results;
  for (const value of results ?? []) {
    const data = value.data;
    const sources = [
      ...new Set([
        ...(data.files ?? []).map((file) => file.path),
        ...(data.path ? [data.path] : []),
      ]),
    ];
    for (const source of sources)
      files.push({
        source,
        ...(observed.has(source) ? { state: "present" as const } : {}),
        effect:
          observed.has(source) ||
          (data.ok === true && data.files?.some((file) => file.path === source))
            ? "applied"
            : (details.effect ?? "unknown"),
      });
    for (const error of data.errors ?? [])
      errors.push({
        code: error.code ?? "MUTATION_FAILED",
        message: error.reason ?? "Mutation failed",
        source: error.path,
      });
    if (data.ok === false && (data.errors?.length ?? 0) === 0)
      errors.push({
        code: "MUTATION_FAILED",
        message: "Mutation failed",
        ...(data.path ? { source: data.path } : {}),
      });
  }
  for (const source of observed)
    if (!files.some((file) => file.source === source))
      files.push({ source, effect: "applied", state: "present" });
  const semantic =
    record(details.metadata) && record(details.metadata.semanticAction)
      ? details.metadata.semanticAction
      : undefined;
  if (semantic) {
    const semanticEffect =
      semantic.effect === "not-applied" || semantic.effect === "unknown"
        ? semantic.effect
        : semantic.ok === false
          ? "unknown"
          : "applied";
    const source = typeof semantic.source === "string" ? semantic.source : undefined;
    if (source)
      files.push({
        source,
        ...(semantic.kind === "file-operation" && semantic.ok === true
          ? {
              state:
                operation === "delete" || operation === "move"
                  ? ("absent" as const)
                  : ("present" as const),
            }
          : {}),
        effect:
          operation === "copy" && typeof semantic.target === "string" && semantic.target !== source
            ? "not-applied"
            : semanticEffect,
      });
    if (typeof semantic.target === "string")
      files.push({
        source: semantic.target,
        effect: semanticEffect,
        ...(semantic.kind === "file-operation" && semantic.ok === true
          ? { state: "present" as const }
          : {}),
      });
    if (record(semantic.error))
      errors.push(
        resultError(
          semantic.error.message,
          typeof semantic.error.code === "string" ? semantic.error.code : "MUTATION_FAILED",
          source,
        ),
      );
    if (typeof semantic.postProcessingError === "string")
      errors.push(resultError(semantic.postProcessingError, "POST_EDIT_FAILED", source));
    if (semantic.ok === false && errors.length === 0)
      errors.push(resultError("Resource operation failed", "MUTATION_FAILED", source));
  }
  const unique = [...new Map(files.map((file) => [file.source, file])).values()];
  if (Array.isArray(details.metadata?.resultFileStates))
    for (const state of details.metadata.resultFileStates) {
      if (!record(state)) continue;
      const file = unique.find((file) => file.source === state.source);
      if (file && (state.state === "present" || state.state === "absent")) file.state = state.state;
    }
  const known = unique.some((file) => file.effect === "applied");
  if (result.isError && errors.length === 0)
    errors.push({ code: "MUTATION_FAILED", message: "Mutation failed" });
  if (
    (results?.length ?? 0) === 0 &&
    !semantic &&
    observed.size === 0 &&
    errors.length === 0 &&
    details.effect !== "not-applied"
  )
    errors.push({ code: "UNKNOWN_RESULT", message: "Mutation effects were not reported" });
  const effect =
    details.effect === "unknown" ||
    unique.some((file) => file.effect === "unknown") ||
    errors.some((error) => error.code === "UNKNOWN_RESULT")
      ? "unknown"
      : known
        ? "applied"
        : "not-applied";
  return {
    status:
      errors.length === 0
        ? "success"
        : !semantic && known && unique.some((file) => file.effect !== "applied")
          ? "partial"
          : "error",
    data: {
      operation,
      effect,
      files: unique,
      ...(operation !== "delete" && typeof details.metadata?.resultTarget === "string"
        ? { target: details.metadata.resultTarget }
        : {}),
      ...(operation !== "delete" && typeof details.metadata?.targetUnavailable === "string"
        ? { targetUnavailable: details.metadata.targetUnavailable }
        : {}),
    },
    errors,
  };
}
/** Attach one validated public mutation receipt without copying before/after contents. */
export function structuredMutation(
  result: AgentToolResult<FileMutationBatchResult>,
  operation: string,
  completions: readonly TextEditCompletion[] = [],
  operationId?: string,
) {
  const outcome = mutationOutcome(result, operation, completions);
  if (outcome.data && operationId !== undefined) outcome.data.operationId = operationId;
  return withStructuredResult(result, mutationDataSchema(operation), outcome);
}
