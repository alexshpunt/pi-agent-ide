import type { ScriptValue } from "./types.ts";

/**
 * Value of a tool that lists paths: the `files` of its result record, in the tool's order.
 * `kind`, when set, is the record kind that carries the list.
 */
export function pathListValue(kind?: string): ScriptValue {
  return {
    schema: { type: "array", items: { type: "string" } },
    project: ({ outcome }) => {
      const data = record(outcome) ? outcome.data : undefined;
      const files =
        record(data) && (kind === undefined || data.kind === kind) ? data.files : undefined;
      if (Array.isArray(files) && files.every((file) => typeof file === "string")) return files;
      // Only a result whose structured content another extension replaced lacks the list. Null
      // keeps the declared type: the readable string would answer `length` and `includes` as if it
      // were the list.
      return null;
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
