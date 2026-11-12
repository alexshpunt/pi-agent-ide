/** Search's public Codemode value; the registered string retains all composition authority. */
export type SearchFacts = {
  result: string;
  hasMatches: boolean | null;
  complete: boolean | null;
};

/** Direct calls still show readable content; native Codemode uses this small return declaration. */
export const searchFactsSchema = {
  type: "object",
  properties: {
    result: {
      type: "string",
      description:
        "Unchanged registered Search result. Pass this string to other tools to reuse its exact selection.",
    },
    hasMatches: {
      anyOf: [{ type: "boolean" }, { type: "null" }],
      description:
        "Whether the original query reported matches, excluding spelling alternatives. Null means unknown. False proves absence only when complete is true.",
    },
    complete: {
      anyOf: [{ type: "boolean" }, { type: "null" }],
      description:
        "Whether the search covered its requested scope, independent of display truncation. Null means unknown.",
    },
  },
  required: ["result", "hasMatches", "complete"],
  additionalProperties: false,
};

/** Project only resolver-owned match facts, never rendered prose, fuzzy suggestions or private data. */
export function searchFacts(outcome: unknown, result: string): SearchFacts {
  const unknown: SearchFacts = { result, hasMatches: null, complete: null };
  if (!record(outcome) || outcome.status !== "success" || !record(outcome.data)) return unknown;
  const data = outcome.data;
  const items =
    data.kind === "matches" ? data.matches : data.kind === "files" ? data.files : undefined;
  if (!Array.isArray(items) || typeof data.complete !== "boolean") return unknown;
  return { result, hasMatches: items.length > 0, complete: data.complete };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
