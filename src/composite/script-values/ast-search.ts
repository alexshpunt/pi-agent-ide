import { searchFacts, searchFactsSchema } from "./search-facts.ts";
import type { ScriptValue } from "./types.ts";

/** ast_search resolves to `{ result, hasMatches, complete }`. */
export const astSearchValue: ScriptValue = {
  schema: searchFactsSchema,
  project: ({ outcome, shown }) => searchFacts(outcome, shown),
};
