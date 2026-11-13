import { noSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/** delete resolves to `null`, since it leaves no text to select, or to a resource provider's value. */
export const deleteValue: ScriptValue = noSelectionValue;
