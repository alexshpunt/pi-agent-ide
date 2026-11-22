import { withStructuredResult, type ResultError, type StructuredResult } from "pi-agent-resource";
import type { ReadToolResult } from "#src/api/tools/read.ts";
import { readDataSchema } from "#src/core/tools/read/structured-result.ts";

/**
 * The result of a Read of several paths: each path's structured result in request order, failures
 * included. The readable text shows each path's result under its path. The call succeeds when every
 * path does, is partial when some fail, and fails when all fail.
 */
export function listReadResult(
  sources: readonly string[],
  results: readonly ReadToolResult[],
): ReadToolResult {
  const items = results.map(({ structuredContent }) => outcomeOf(structuredContent));
  // Each failed path says what a Read of that path alone would show, with its recovery steps.
  const errors: ResultError[] = items.flatMap((item, index) => {
    const [first] = item.errors;
    if (item.status === "success" || first === undefined) return [];
    const shown = (results[index]?.content ?? [])
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    return [
      {
        ...first,
        message: shown || first.message,
        source: first.source ?? sources[index] ?? "",
      },
    ];
  });
  const failed = items.filter((item) => item.status !== "success").length;
  const content = results.flatMap((result, index) => [
    { type: "text" as const, text: `--- ${sources[index] ?? ""} ---` },
    ...result.content,
  ]);
  return withStructuredResult(
    { content, details: {} },
    readDataSchema,
    {
      status: failed === 0 ? "success" : failed === items.length ? "error" : "partial",
      data: { kind: "list", items },
      errors,
    },
    // Each path's data already has its own bound.
    { maxBytes: Infinity },
  );
}

/** The outcome `structuredRead` validated for one path, or a failure when a result has none. */
function outcomeOf(value: unknown): StructuredResult {
  if (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    (value.status === "success" || value.status === "error" || value.status === "partial") &&
    "errors" in value &&
    Array.isArray(value.errors)
  ) {
    const errors: unknown[] = value.errors;
    return {
      status: value.status,
      ...("data" in value && { data: value.data }),
      errors: errors.filter(
        (error): error is ResultError =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          "message" in error &&
          typeof error.message === "string",
      ),
    };
  }
  return {
    status: "error",
    errors: [
      { code: "STRUCTURED_ADAPTER_REQUIRED", message: "Read returned no structured result" },
    ],
  };
}
