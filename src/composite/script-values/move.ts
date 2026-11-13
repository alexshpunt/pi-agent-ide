import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/**
 * move resolves to the `RESULT#<uuid>` of the moved text, including a whole moved text file,
 * `null` for a directory or binary move, or to a resource provider's value.
 */
export const moveValue: ScriptValue = editSelectionValue;
