import type { JsonValue } from "@earendil-works/pi-ai";
import { providerValue, providerValueSchema } from "./provider-value.ts";
import { resultReference } from "./result-reference.ts";
import type { ScriptValue, ScriptValueInput } from "./types.ts";

/**
 * Value of an edit that can produce text: the `RESULT#<uuid>` of its published result when the
 * result selects the new text, `null` when it selects none, or a resource provider's value.
 */
export const editSelectionValue: ScriptValue = {
  schema: {
    anyOf: [
      {
        type: "string",
        description:
          "RESULT#<uuid> that selects the text the edit produced; pass it to a source parameter. Null when the edit selects no text or its selection cannot be verified, even if the edit succeeded. Check the failure block; read the file before further edits when no selection is verified.",
      },
      providerValueSchema,
    ],
  },
  project: (input) => providerValue(input.details) ?? editSelection(input),
  // A refused or uncertain provider action keeps its receipt, which says what happened.
  failed: ({ details }) => providerValue(details),
};

/**
 * Value of an edit that never produces text, such as Delete: `null`, or a resource provider's
 * value.
 */
export const noSelectionValue: ScriptValue = {
  schema: providerValueSchema,
  project: ({ details }) => providerValue(details) ?? null,
  failed: ({ details }) => providerValue(details),
};

/**
 * The reference of a successful edit result whose record names a verified text target. A pending
 * edit names its reserved target: the next call that uses it commits the script's batch first.
 */
function editSelection({ outcome, shown }: ScriptValueInput): JsonValue {
  const data = record(outcome) && outcome.status === "success" ? outcome.data : undefined;
  if (!record(data) || typeof data.target !== "string") return null;
  return resultReference(shown) ?? null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
