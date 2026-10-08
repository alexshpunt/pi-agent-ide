import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** A failed operation may still have observed data and committed effects. */
export interface ResultError {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}
/** Public data is separate from renderer details. Partial means incomplete execution, not clipped data. */
export interface StructuredResult<T = unknown> {
  readonly status: "success" | "error" | "partial";
  readonly data?: T;
  readonly errors: readonly ResultError[];
}
export const resultErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    source: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Build the common result contract around one tool's data schema. */
export function structuredResultSchema(data: TSchema) {
  const outcomes = Type.Union([
    Type.Object(
      {
        status: Type.Literal("success"),
        data,
        errors: Type.Array(resultErrorSchema, { maxItems: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        status: Type.Union([Type.Literal("error"), Type.Literal("partial")]),
        data: Type.Optional(data),
        errors: Type.Array(resultErrorSchema, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ]);
  // Expose the common object fields without weakening outcome-specific validation.
  return {
    ...outcomes,
    type: "object" as const,
    properties: {
      status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("partial")]),
      data: Type.Optional(data),
      errors: Type.Array(resultErrorSchema),
    },
    required: ["status", "errors"],
    additionalProperties: false,
  };
}
/** Maximum serialized public data; callers expose a smaller window or a full-result resource. */
export const MAX_STRUCTURED_BYTES = 1024 * 1024;

/** Reject classes, bytes, cycles and lossy JSON values rather than silently changing their meaning. */
export function assertJsonData(
  value: unknown,
): asserts value is NonNullable<AgentToolResult<unknown>["structuredContent"]> {
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item))
      throw new TypeError("Structured data must be finite, acyclic JSON");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("Structured data must not contain classes or raw byte buffers");
    ancestors.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child);
    ancestors.delete(item);
  };
  visit(value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_STRUCTURED_BYTES)
    throw new RangeError(
      "Structured data exceeds 1 MiB; return a smaller window or a full-result reference",
    );
}

/** Normalize thrown errors without exposing causes, stacks or internal objects. */
export function resultError(
  error: unknown,
  code = "EXECUTION_FAILED",
  source?: string,
): ResultError {
  return {
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : code,
    message: error instanceof Error ? error.message : String(error),
    ...(source === undefined ? {} : { source }),
  };
}

/** Validate at the owning boundary and make native isError agree with the public outcome. */
export function withStructuredResult<D, T>(
  result: AgentToolResult<D>,
  dataSchema: TSchema,
  outcome: StructuredResult<T>,
): AgentToolResult<D> {
  try {
    assertJsonData(outcome);
    if (!Value.Check(structuredResultSchema(dataSchema), outcome))
      throw new TypeError("Result adapter returned data outside its public schema");
    return {
      ...result,
      structuredContent: outcome,
      isError: outcome.status !== "success",
    };
  } catch (error) {
    const normalized = resultError(error, "INVALID_STRUCTURED_RESULT");
    const failure: StructuredResult = {
      status: "error",
      errors: [normalized],
    };
    assertJsonData(failure);
    return {
      ...result,
      content: [...result.content, { type: "text", text: normalized.message }],
      structuredContent: failure,
      isError: true,
    };
  }
}
