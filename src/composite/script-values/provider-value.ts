import type { JsonValue } from "@earendil-works/pi-ai";

/** A value a resource provider's semantic action returns to scripts, such as a computer action outcome. */
export const providerValueSchema = {
  type: "object",
  description: "Value returned by a resource provider, such as a computer action outcome.",
  additionalProperties: true,
} as const;

/** The value a semantic handler asked to return to scripts instead of text. */
export function providerValue(details: unknown): JsonValue | undefined {
  const metadata = record(details) ? details.metadata : undefined;
  const action = record(metadata) ? metadata.semanticAction : undefined;
  const value = record(action) ? action.script : undefined;
  // Semantic handler results are plain JSON receipts; keep the declared object shape.
  return record(value) && !Array.isArray(value) ? (value as JsonValue) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
