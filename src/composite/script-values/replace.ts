import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/** replace resolves to the `RESULT#<uuid>` of the new text, or to a resource provider's value. */
export const replaceValue: ScriptValue = editSelectionValue;
