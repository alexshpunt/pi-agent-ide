import type { JsonValue } from "@earendil-works/pi-ai";
import type { ScriptValue } from "./types.ts";

/**
 * Value of an edit tool whose resource provider may return a plain value instead of text, such as
 * a computer action outcome. Other results resolve to the readable result string.
 */
export const providerTextValue: ScriptValue = {
  schema: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        description: "Value returned by a resource provider, such as a computer action outcome.",
        additionalProperties: true,
      },
    ],
  },
  project: ({ details, shown }) => providerValue(details) ?? shown,
  // A refused or uncertain provider action keeps its receipt, which says what happened.
  failed: ({ details }) => providerValue(details),
};

/** The value a semantic handler asked to return to scripts instead of text. */
function providerValue(details: unknown): JsonValue | undefined {
  const metadata = record(details) ? details.metadata : undefined;
  const action = record(metadata) ? metadata.semanticAction : undefined;
  const value = record(action) ? action.script : undefined;
  // Semantic handler results are plain JSON receipts; keep the declared object shape.
  return record(value) && !Array.isArray(value) ? (value as JsonValue) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
