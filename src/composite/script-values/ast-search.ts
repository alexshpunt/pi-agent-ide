import type { JsonValue } from "@earendil-works/pi-ai";
import { scriptMatchSchema } from "./match.ts";
import { matchList, matchListSchema, record, scriptMatch } from "./search-matches.ts";
import type { ScriptValue } from "./types.ts";

const captureSchema = {
  type: "object",
  properties: { text: { type: "string" }, id: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;

/**
 * ast_search resolves to `{ id, complete, matches }` like Search, and each match adds `captures`:
 * the nodes of each metavariable, keyed by its name without `$`, as `{ text, id }`.
 */
export const astSearchValue: ScriptValue = {
  schema: matchListSchema({
    ...scriptMatchSchema,
    properties: {
      ...scriptMatchSchema.properties,
      captures: {
        type: "object",
        description: "Nodes of each metavariable, keyed by its name without $.",
        additionalProperties: { type: "array", items: captureSchema },
      },
    },
    required: [...scriptMatchSchema.required, "captures"],
  }),
  project(input) {
    const list = matchList(input);
    if (list === undefined) return input.shown;
    const matches: JsonValue[] = [];
    for (const { match, data } of list.matches) {
      const captures: Record<string, JsonValue> = {};
      for (const [name, nodes] of Object.entries(record(data.captures) ? data.captures : {})) {
        if (!Array.isArray(nodes)) return input.shown;
        const projected: JsonValue[] = [];
        for (const node of nodes as unknown[]) {
          const selected = record(node) ? scriptMatch(node, input.cwd) : undefined;
          if (selected === undefined) return input.shown;
          projected.push({
            text: selected.text,
            ...(selected.id !== undefined && { id: selected.id }),
          });
        }
        captures[name] = projected;
      }
      matches.push({ ...match, captures });
    }
    return {
      ...(list.id !== undefined && { id: list.id }),
      complete: list.complete,
      matches,
    };
  },
};
