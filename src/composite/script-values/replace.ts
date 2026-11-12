import { providerTextValue } from "./provider-value.ts";
import type { ScriptValue } from "./types.ts";

/** replace resolves to its readable result string, or to a resource provider's value. */
export const replaceValue: ScriptValue = providerTextValue;
