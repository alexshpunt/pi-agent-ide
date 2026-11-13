import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/** undo resolves to the `RESULT#<uuid>` of the whole restored file, or `null` when it selects none. */
export const undoValue: ScriptValue = editSelectionValue;
