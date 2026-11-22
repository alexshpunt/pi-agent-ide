import type { ScriptValue } from "./types.ts";

/**
 * diff resolves to the complete unified diff, or `""` when the sources are equal. The readable
 * result of a direct call is bounded, so the value comes from the tool's full comparison.
 */
export const diffValue: ScriptValue = {
  schema: {
    type: "string",
    description: 'Complete unified diff of the two sources; "" when they are equal.',
  },
  project({ details, shown }) {
    const comparison = record(details) ? details.comparison : undefined;
    // Only a result whose details another extension replaced lacks its comparison; the script
    // then gets the readable result, as a direct call shows it.
    if (
      !record(comparison) ||
      typeof comparison.equal !== "boolean" ||
      typeof comparison.diff !== "string"
    )
      return shown;
    return comparison.equal ? "" : comparison.diff;
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
