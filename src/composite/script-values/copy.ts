import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/**
 * copy resolves to the `RESULT#<uuid>` of the copied text, including a whole copied text file,
 * `null` for a directory or binary copy, or to a resource provider's value.
 */
export const copyValue: ScriptValue = editSelectionValue;
