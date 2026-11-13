import { matchList, matchListSchema, record } from "./search-matches.ts";
import { scriptMatchSchema } from "./match.ts";
import type { ScriptValue } from "./types.ts";

/**
 * Search resolves to `{ id, complete, matches: { path, line, text, id }[] }` with every match and
 * its whole text. A source without selections, such as terminal output or a guide, gives matches
 * without ids. A result that is not a list of text matches, such as a provider's object list,
 * resolves to its readable result. Fallback matches have their own selection; notices remain visible.
 * Possible-name suggestions stay out of the value.
 */
export const searchValue: ScriptValue = {
  schema: matchListSchema(scriptMatchSchema, {
    fallback: {
      type: "object",
      description:
        "A broader search tried after the original query found no matches. Its id and matches select only the broadened results.",
      properties: {
        mode: { type: "string", enum: ["regex", "words"] },
        id: { type: "string" },
        complete: { type: "boolean" },
        matches: { type: "array", items: scriptMatchSchema },
      },
      required: ["mode", "complete", "matches"],
      additionalProperties: false,
    },
    notices: {
      type: "array",
      items: { type: "string" },
      description: "Search notices, including fallback and coverage details.",
    },
    editWarning: {
      type: "string",
      description: "Why editing this selection as a whole is unsafe.",
    },
  }),
  project(input) {
    const list = matchList(input);
    if (list === undefined) return input.shown;
    const matches = list.matches.map(({ match }) => ({ ...match }));
    const data = record(input.outcome) && record(input.outcome.data) ? input.outcome.data : {};
    const fallback =
      data.fallback === "regex" || data.fallback === "words" ? data.fallback : undefined;
    const notices =
      Array.isArray(data.notices) && data.notices.every((notice) => typeof notice === "string")
        ? (data.notices as string[])
        : [];
    const selection = {
      ...(list.id !== undefined && { id: list.id }),
      complete: list.complete,
      matches,
    };
    return {
      ...(fallback === undefined
        ? selection
        : { complete: true, matches: [], fallback: { mode: fallback, ...selection } }),
      ...(notices.length === 0 ? {} : { notices }),
      ...(typeof data.editWarning === "string" ? { editWarning: data.editWarning } : {}),
    };
  },
};
