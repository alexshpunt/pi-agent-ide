import { textValue } from "./text.ts";
import type { ScriptValue } from "./types.ts";

/** bash, powershell, remote_bash and remote_powershell resolve to their readable result string. */
export const terminalValue: ScriptValue = textValue;
