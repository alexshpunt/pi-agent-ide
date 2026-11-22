import { pathListValue } from "./path-list.ts";
import type { ScriptValue } from "./types.ts";

/**
 * semantic_search resolves to the found files in rank order, relative to the project. Approximate
 * ranges stay out: they are hints, not selections.
 */
export const semanticSearchValue: ScriptValue = pathListValue();
