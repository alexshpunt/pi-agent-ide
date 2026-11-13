import { matchList, matchListSchema } from "./search-matches.ts";
import type { ScriptValue } from "./types.ts";

/**
 * Search resolves to `{ id, complete, matches: { path, line, text, id }[] }` with every match and
 * its whole text. A source without selections, such as terminal output or a guide, gives matches
 * without ids. A result that is not a list of text matches, such as a provider's object list,
 * resolves to its readable result. Possible-name suggestions stay out of the value.
 */
export const searchValue: ScriptValue = {
  schema: matchListSchema(),
  project(input) {
    const list = matchList(input);
    if (list === undefined) return input.shown;
    const matches = list.matches.map(({ match }) => ({ ...match }));
    return {
      ...(list.id !== undefined && { id: list.id }),
      complete: list.complete,
      matches,
    };
  },
};
