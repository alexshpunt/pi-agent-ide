import { searchFacts, searchFactsSchema } from "./search-facts.ts";
import type { ScriptValue } from "./types.ts";

/** lsp_search resolves to `{ result, hasMatches, complete }`. */
export const lspSearchValue: ScriptValue = {
  schema: searchFactsSchema,
  project: ({ outcome, shown }) => searchFacts(outcome, shown),
};
