import { expect, test } from "vitest";
import {
  FuzzyVocabulary,
  fuzzyLimits,
  isFuzzyQuery,
  rankFuzzyIdentifiers,
} from "#src/api/fuzzy.js";

test("mixes spelling tiers in stable order without claiming synonyms", () => {
  const names = [
    "generateHintString",
    "deleteHintStrings",
    "hintStrings",
    "generate_hint_strings",
    "GenerateHintStrings",
    "makeLabels",
    "generateHintStrings",
  ];
  const ranked = rankFuzzyIdentifiers("generateHintStrings", names);
  expect(ranked.map(({ identifier, kind }) => [identifier, kind])).toEqual([
    ["GenerateHintStrings", "normalized"],
    ["generate_hint_strings", "normalized"],
    ["hintStrings", "component"],
    ["generateHintString", "typo"],
  ]);
  expect(rankFuzzyIdentifiers("generateHintStrings", names.toReversed())).toEqual(ranked);
  expect(rankFuzzyIdentifiers("storeResult", ["scoreResult"])[0]?.kind).toBe("typo");
  expect(rankFuzzyIdentifiers("sha256Digest", ["sha512Digest"])).toEqual([]);
  expect(rankFuzzyIdentifiers("HTTPClient", ["http_client"])[0]?.kind).toBe("normalized");
});
test.each([
  '"hintStrings"',
  "hint Strings",
  "regex:hint",
  "files:hint",
  "foo OR bar",
  "_____",
  "12345",
  "a".repeat(81),
])("does not expand explicit syntax or unsuitable names: %s", (query) => {
  expect(isFuzzyQuery(query)).toBe(false);
});
test("retains unique tokens only and stops on collection budgets", () => {
  const vocabulary = new FuzzyVocabulary();
  vocabulary.addText("hintStrings ".repeat(100_000));
  expect([...vocabulary.names]).toEqual(["hintStrings"]);
  expect(vocabulary.limited).toBe(false);
  expect(vocabulary.account(fuzzyLimits.vocabularyBytes)).toBe(false);
  vocabulary.add("anotherName");
  expect([...vocabulary.names]).toEqual(["hintStrings"]);
  const distinct = new FuzzyVocabulary();
  for (let index = 0; index <= fuzzyLimits.identifiers; index++)
    distinct.add("token" + String(index));
  expect(distinct.names.size).toBe(fuzzyLimits.identifiers);
  expect(distinct.limited).toBe(true);
});
