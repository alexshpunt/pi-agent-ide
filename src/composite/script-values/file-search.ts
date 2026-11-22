import { pathListValue } from "./path-list.ts";
import type { ScriptValue } from "./types.ts";

/**
 * file_search resolves to the matching paths, as a direct call lists them: local paths relative to
 * the session directory, SSH paths as `ssh://` URLs. A script's call lists every match unless it
 * sets `limit`.
 */
const paths = pathListValue("files");
export const fileSearchValue: ScriptValue = { ...paths, failed: paths.project };
