import { searchFacts, searchFactsSchema } from "./search-facts.ts";
import type { ScriptValue } from "./types.ts";

/** Search resolves to `{ result, hasMatches, complete }`. */
export const searchValue: ScriptValue = {
  schema: searchFactsSchema,
  project: ({ outcome, shown }) => searchFacts(outcome, shown),
};
