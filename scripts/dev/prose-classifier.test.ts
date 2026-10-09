import { expect, test } from "vitest";
import { buildState, summarize, type Classification } from "./prose-classifier/core.ts";

test("sends the assertion and source context without reference labels", () => {
  const source =
    'import { expect, test } from "vitest";\ntest("round trip", () => {\n  const input = "sample";\n  expect(copy(input)).toBe(input);\n});\nfunction copy(value: string) { return value; }\n';
  const state = buildState(
    {
      id: "fixture",
      split: "holdout",
      expected: "contract",
      rationale: "reference only",
      file: "fixture.test.ts",
      line: 4,
    },
    source,
  );
  expect(state.targetAssertion).toBe("expect(copy(input)).toBe(input);");
  expect(state.source).toBe(source);
  expect(state).not.toHaveProperty("expected");
  expect(state).not.toHaveProperty("rationale");
  expect(state).not.toHaveProperty("split");
});

test("refuses to classify when a source location no longer identifies an assertion", () => {
  expect(() =>
    buildState(
      {
        id: "moved",
        split: "holdout",
        expected: "contract",
        rationale: "reference only",
        file: "fixture.test.ts",
        line: 1,
      },
      "const value = 4;\n",
    ),
  ).toThrow(Error);
});

test("keeps abstentions and provider failures out of clean verdicts", () => {
  const rows: Classification[] = [
    { expected: "prose", predicted: "prose" },
    { expected: "prose", predicted: "contract" },
    { expected: "contract", predicted: "prose" },
    { expected: "contract", predicted: "unknown" },
    { expected: "unknown", predicted: "unknown" },
    { expected: "prose", predicted: "error" },
  ];
  expect(summarize(rows)).toMatchObject({
    total: 6,
    correct: 2,
    errors: 1,
    abstentions: 2,
    prosePrecision: 0.5,
    proseRecall: 1 / 3,
    confusion: {
      prose: { prose: 1, contract: 1, unknown: 0, error: 1 },
      contract: { prose: 1, contract: 0, unknown: 1, error: 0 },
    },
  });
});

test("does not claim precision or recall when there is no denominator", () => {
  expect(summarize([])).toMatchObject({ total: 0, prosePrecision: null, proseRecall: null });
});
