import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { searchFacts, searchFactsSchema } from "./search-facts.js";

const result = "unchanged issued result";

for (const [kind, items] of [
  ["matches", "matches"],
  ["files", "files"],
] as const) {
  for (const complete of [true, false]) {
    test(`${kind} reports observed presence separately from coverage ${complete}`, () => {
      for (const values of [[], ["one"]]) {
        const facts = searchFacts(
          { status: "success", data: { kind, [items]: values, complete } },
          result,
        );
        expect(facts).toEqual({ result, hasMatches: values.length > 0, complete });
        expect(Value.Check(searchFactsSchema, facts)).toBe(true);
      }
    });
  }
}

test("fuzzy alternatives and display truncation do not change original-query facts", () => {
  const facts = searchFacts(
    {
      status: "success",
      data: {
        kind: "matches",
        matches: [],
        complete: true,
        truncated: true,
        fuzzy: { candidates: [{ matchCount: 12 }] },
      },
    },
    result,
  );
  expect(facts).toEqual({ result, hasMatches: false, complete: true });
  expect(Object.keys(facts).sort()).toEqual(["complete", "hasMatches", "result"]);
});

test("custom, partial and malformed facts stay unknown without leaking their payload", () => {
  for (const outcome of [
    undefined,
    { status: "partial", data: { kind: "matches", matches: [], complete: true } },
    { status: "error", data: { kind: "matches", matches: [], complete: true } },
    { status: "success", data: { kind: "custom", value: { matches: [], complete: true } } },
    { status: "success", data: { kind: "matches", matches: [] } },
  ]) {
    expect(searchFacts(outcome, result)).toEqual({ result, hasMatches: null, complete: null });
  }
});
