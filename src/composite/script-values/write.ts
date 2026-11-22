import { editSelectionValue } from "./edit-selection.ts";
import type { ScriptValue } from "./types.ts";

/**
 * write resolves to the `RESULT#<uuid>` of the written text, `null` when it selects no text, such
 * as an image Write, or to a resource provider's value.
 */
export const writeValue: ScriptValue = editSelectionValue;
