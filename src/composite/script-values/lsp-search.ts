import type { JsonValue } from "@earendil-works/pi-ai";

import { astSearchValue, captureSchema } from "./ast-search.ts";
import { scriptMatchPath, scriptMatchSchema } from "./match.ts";
import { matchEntries, matchListSchema, record } from "./search-matches.ts";
import { searchValue } from "./search.ts";
import type { ScriptValue, ScriptValueInput } from "./types.ts";

const matches = { type: "array", items: scriptMatchSchema } as const;

/**
 * lsp_search resolves to `{ id, complete, matches }` like Search for `query`, `references` and
 * `declaration`, and to `{ id, complete, matches, incoming, outgoing }` for `calls`: references in
 * `matches`, callers and callees as their whole declarations. Query results also carry `skipped`
 * when workspace candidates lack a declaration anchor. In a call graph, `id` selects every reference.
 */
export const lspSearchValue: ScriptValue = {
  schema: {
    anyOf: [
      {
        type: "object",
        description: "calls: references in matches, callers in incoming, callees in outgoing.",
        properties: {
          id: { type: "string" },
          complete: { type: "boolean" },
          matches,
          incoming: matches,
          outgoing: matches,
        },
        required: ["id", "complete", "matches", "incoming", "outgoing"],
        additionalProperties: false,
      },
      ...matchListSchema(
        {
          ...scriptMatchSchema,
          properties: {
            ...scriptMatchSchema.properties,
            captures: {
              type: "object",
              properties: { name: { type: "array", items: captureSchema } },
              additionalProperties: false,
            },
          },
        },
        {
          skipped: {
            type: "array",
            description: "Query candidates with no declaration anchor; the result is incomplete.",
            items: {
              type: "object",
              properties: { name: { type: "string" }, path: { type: "string" } },
              required: ["name", "path"],
              additionalProperties: false,
            },
          },
        },
      ).anyOf,
    ],
  },
  project(input) {
    const data =
      record(input.outcome) && input.outcome.status === "success" ? input.outcome.data : undefined;
    if (record(data) && data.kind === "custom") return callGraph(data.value, input) ?? input.shown;
    if (
      record(data) &&
      Array.isArray(data.matches) &&
      data.matches.some((match: unknown) => record(match) && record(match.captures))
    )
      return astSearchValue.project(input);
    const result = searchValue.project(input);
    if (record(result) && record(data) && Array.isArray(data.skipped))
      return {
        ...result,
        skipped: data.skipped.flatMap((item: unknown) =>
          record(item) && typeof item.name === "string" && typeof item.source === "string"
            ? [{ name: item.name, path: scriptMatchPath(item.source, input.cwd) }]
            : [],
        ),
      };
    return result;
  },
};

/** A call graph's references, callers and callees, each list with its own ids. */
function callGraph(graph: unknown, input: ScriptValueInput): JsonValue | undefined {
  if (!record(graph)) return undefined;
  const lists = [graph.matches, graph.incoming, graph.outgoing].map((list) =>
    places(list, input.cwd),
  );
  const [references, incoming, outgoing] = lists;
  if (
    typeof graph.target !== "string" ||
    typeof graph.complete !== "boolean" ||
    references === undefined ||
    incoming === undefined ||
    outgoing === undefined
  )
    return undefined;
  return {
    id: graph.target,
    // A shortened list, as in the preview of a call that no script made, is not complete.
    complete: graph.complete && lists.every((list) => list?.complete === true),
    matches: references.matches,
    incoming: incoming.matches,
    outgoing: outgoing.matches,
  };
}

function places(
  list: unknown,
  cwd: string | undefined,
): { complete: boolean; matches: JsonValue[] } | undefined {
  if (!record(list) || list.kind !== "matches" || !Array.isArray(list.matches)) return undefined;
  const found = matchEntries(list.matches, cwd);
  if (found === undefined) return undefined;
  return { complete: list.truncated !== true, matches: found.map(({ match }) => ({ ...match })) };
}
