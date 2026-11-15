import { readValue } from "./read.ts";
import type { ScriptValue } from "./types.ts";

/** A declaration outline retains its complete text and source-aware result reference. */
export const outlineValue: ScriptValue = {
  schema: {
    type: "object",
    properties: { text: { type: "string" }, id: { type: "string" } },
    required: ["text", "id"],
  },
  project: readValue.project,
};
