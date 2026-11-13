import type { JsonValue } from "@earendil-works/pi-ai";

import { scriptMatchSchema } from "./match.ts";
import { matchEntries, matchListSchema, record } from "./search-matches.ts";
import { searchValue } from "./search.ts";
import type { ScriptValue, ScriptValueInput } from "./types.ts";

const matches = { type: "array", items: scriptMatchSchema } as const;

/**
 * lsp_search resolves to `{ id, complete, matches }` like Search for `query`, `references` and
 * `declaration`, and to `{ id, complete, matches, incoming, outgoing }` for `calls`: references in
 * `matches`, callers and callees as their whole declarations. `id` selects every reference.
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
      ...matchListSchema().anyOf,
    ],
  },
  project(input) {
    const data =
      record(input.outcome) && input.outcome.status === "success" ? input.outcome.data : undefined;
    if (record(data) && data.kind === "custom") return callGraph(data.value, input) ?? input.shown;
    return searchValue.project(input);
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
