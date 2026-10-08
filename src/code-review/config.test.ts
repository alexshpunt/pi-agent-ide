import { expect, test } from "vitest";
import { parseReviewRules } from "./config.js";

test("loads natural-language YAML rules and omits disabled rules", () => {
  expect(
    parseReviewRules(`rules:
  - id: hidden-errors
    description: >
      Do not hide a failed operation.
      Explicit recovery is allowed.
  - id: ignored
    description: Disabled rule.
    enabled: false
`),
  ).toEqual([
    {
      id: "hidden-errors",
      description: "Do not hide a failed operation. Explicit recovery is allowed.",
    },
  ]);
});

test("empty rules do not create an implicit good-code policy", () => {
  expect(parseReviewRules("rules: []")).toEqual([]);
});

test.each([
  "rules: nope",
  "rules: [{id: one}]",
  "rules: [{id: one, description: ' '}]",
  "rules: [{id: one, description: a}, {id: one, description: b}]",
  "rules: [{id: one, description: a, enabled: yes}]",
  "rules: [{id: one, description: a, typo: true}]",
  "rules: []\nrules: []",
])("rejects malformed or ambiguous rules: %s", (source) => {
  expect(() => parseReviewRules(source)).toThrow(/.+/);
});
