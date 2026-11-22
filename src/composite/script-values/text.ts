import type { ScriptValue } from "./types.ts";

/** The readable result string: the value of IDE tools that declare no value of their own. */
export const textValue: ScriptValue = {
  schema: { type: "string" },
  project: ({ shown }) => shown,
};
