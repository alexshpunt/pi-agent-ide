import { providerTextValue } from "./provider-value.ts";
import type { ScriptValue } from "./types.ts";

/** insert resolves to its readable result string, or to a resource provider's value. */
export const insertValue: ScriptValue = providerTextValue;
