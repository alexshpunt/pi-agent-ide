import { searchFacts, searchFactsSchema } from "./search-facts.ts";
import type { ScriptValue } from "./types.ts";

/** file_search resolves to `{ result, hasMatches, complete }`. */
export const fileSearchValue: ScriptValue = {
  schema: searchFactsSchema,
  project: ({ outcome, shown }) => searchFacts(outcome, shown),
};
