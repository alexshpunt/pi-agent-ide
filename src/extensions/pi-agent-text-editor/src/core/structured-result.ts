import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  resultError,
  resultErrorSchema,
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
  { source: Type.String(), effect, action: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const operation = Type.Object(
  {
    id: Type.String(),
    operation: Type.String(),
    effect,
    errors: Type.Array(resultErrorSchema),
    status: Type.Optional(
      Type.Union([
        Type.Literal("success"),
        Type.Literal("error"),
        Type.Literal("warning"),
        Type.Literal("unknown"),
      ]),
    ),
    sources: Type.Optional(Type.Array(Type.String())),
    warnings: Type.Optional(Type.Array(resultErrorSchema)),
  },
  { additionalProperties: false },
);
export const mutationDataSchema = Type.Object(
  {
    operation: Type.String(),
    effect,
    operationId: Type.Optional(Type.String()),
    files: Type.Array(file),
    operations: Type.Optional(Type.Array(operation)),
    parentToolCallId: Type.Optional(Type.String()),
    transaction: Type.Optional(Type.String()),
    transactions: Type.Optional(Type.Array(Type.String())),
    recovery: Type.Optional(
      Type.Array(
        Type.Object({
          source: Type.String(),
          field: Type.String(),
          anchor: Type.String(),
          total: Type.Integer(),
          candidates: Type.Array(
            Type.Object({
              rank: Type.Integer(),
              range: Type.Object({
                start: Type.Object({ lineNumber: Type.Integer(), column: Type.Integer() }),
                end: Type.Object({ lineNumber: Type.Integer(), column: Type.Integer() }),
              }),
            }),
          ),
        }),
      ),
    ),
    action: Type.Optional(
      Type.Object(
        {
          source: Type.String(),
          kind: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          command: Type.Optional(Type.String()),
          deleted: Type.Optional(Type.Boolean()),
          session: Type.Optional(Type.String()),
          file: Type.Optional(Type.String()),
          line: Type.Optional(Type.Integer()),
          verified: Type.Optional(Type.Boolean()),
          evaluation: Type.Optional(
            Type.Object(
              {
                expression: Type.String(),
                result: Type.String(),
                type: Type.Optional(Type.String()),
                variablesReference: Type.Integer(),
              },
              { additionalProperties: false },
            ),
          ),
          breakpoints: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  source: Type.String(),
                  file: Type.String(),
                  line: Type.Integer(),
                  verified: Type.Boolean(),
                },
                { additionalProperties: false },
              ),
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const mutationOutputSchema = structuredResultSchema(mutationDataSchema);
/** Public receipt fields are defined by the native output schema. */
export type MutationData = Static<typeof mutationDataSchema>;
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
        files:
          typeof detailRecord.source === "string"
            ? [{ source: detailRecord.source, effect: "pending" }]
            : [],
        ...(typeof native.parentToolCallId === "string"
          ? { parentToolCallId: native.parentToolCallId }
          : {}),
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
    if (!files.some((file) => file.source === source)) files.push({ source, effect: "applied" });
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
    if (source && !Array.isArray(semantic.restored))
      files.push({
        source,
        effect:
          operation === "copy" && typeof semantic.target === "string" && semantic.target !== source
            ? "not-applied"
            : semanticEffect,
      });
    if (Array.isArray(semantic.restored))
      for (const source of semantic.restored)
        if (typeof source === "string") files.push({ source, effect: semanticEffect });
    if (typeof semantic.target === "string")
      files.push({ source: semantic.target, effect: semanticEffect });
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
  const known = unique.some((file) => file.effect === "applied");
  if (result.isError && errors.length === 0)
    errors.push({ code: "MUTATION_FAILED", message: "Mutation failed" });
  if ((results?.length ?? 0) === 0 && !semantic && observed.size === 0 && errors.length === 0)
    errors.push({ code: "UNKNOWN_RESULT", message: "Mutation effects were not reported" });
  const effect =
    unique.some((file) => file.effect === "unknown") ||
    errors.some((error) => error.code === "UNKNOWN_RESULT")
      ? "unknown"
      : known
        ? "applied"
        : "not-applied";
  const action =
    semantic && typeof semantic.source === "string"
      ? {
          source: semantic.source,
          ...(typeof semantic.kind === "string" ? { kind: semantic.kind } : {}),
          ...(typeof semantic.status === "string" ? { status: semantic.status } : {}),
          ...(typeof semantic.command === "string" ? { command: semantic.command } : {}),
          ...(typeof semantic.deleted === "boolean" ? { deleted: semantic.deleted } : {}),
          ...(typeof semantic.session === "string" ? { session: semantic.session } : {}),
          ...(typeof semantic.file === "string" ? { file: semantic.file } : {}),
          ...(typeof semantic.line === "number" ? { line: semantic.line } : {}),
          ...(typeof semantic.verified === "boolean" ? { verified: semantic.verified } : {}),
          ...(record(semantic.evaluation)
            ? {
                evaluation: {
                  expression: semantic.evaluation.expression,
                  result: semantic.evaluation.result,
                  variablesReference: semantic.evaluation.variablesReference,
                  ...(typeof semantic.evaluation.type === "string"
                    ? { type: semantic.evaluation.type }
                    : {}),
                },
              }
            : {}),
          ...(Array.isArray(semantic.breakpoints)
            ? {
                breakpoints: semantic.breakpoints.filter(record).map((breakpoint) => ({
                  source: breakpoint.source,
                  file: breakpoint.file,
                  line: breakpoint.line,
                  verified: breakpoint.verified,
                })),
              }
            : {}),
        }
      : undefined;
  const checkedAction =
    action && Value.Check(mutationDataSchema.properties.action, action) ? action : undefined;
  if (action && !checkedAction)
    errors.push(resultError("Action adapter returned invalid fields", "INVALID_STRUCTURED_RESULT"));
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
      ...(details.anchorRecoveries === undefined
        ? {}
        : {
            recovery: details.anchorRecoveries.map((item) => ({
              source: item.path,
              field: item.field,
              anchor: item.anchor,
              total: item.total,
              candidates: [...item.candidates],
            })),
          }),
      ...(typeof semantic?.transaction === "string" ? { transaction: semantic.transaction } : {}),
      ...(checkedAction ? { action: checkedAction } : {}),
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
  return withStructuredResult(result, mutationDataSchema, outcome);
}
