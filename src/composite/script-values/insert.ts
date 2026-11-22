import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/** insert resolves to the `RESULT#<uuid>` of the inserted text, or to a resource provider's value. */
export const insertValue: ScriptValue = editSelectionValue;
