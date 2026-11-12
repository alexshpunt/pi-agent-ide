import { providerTextValue } from "./provider-value.ts";
import type { ScriptValue } from "./types.ts";

/** write resolves to its readable result string, or to a resource provider's value. */
export const writeValue: ScriptValue = providerTextValue;
