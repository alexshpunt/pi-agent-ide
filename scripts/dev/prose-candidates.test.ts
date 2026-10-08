import { expect, test } from "vitest";
import { extractTests } from "./prose-candidates/discovery.ts";
import { decision, validateReviews } from "./prose-candidates/review.ts";
import type { ClassifierResult } from "@earendil-works/pi-ai";

const header = 'import { test, it as check } from "vitest";\n';

test("discovers declarations without requiring prose or even an assertion", () => {
  const source =
    header +
    'test("numeric", () => { expect(4).toBe(4); });\ncheck("empty", () => {});\ntest.each([1, 2])("parameterized", value => { expect(value).toBeGreaterThan(0); });\n';
  const result = extractTests("src/fixture.test.ts", source);
  expect(result.tests).toHaveLength(3);
  expect(result.tests.map((item) => item.kind)).toEqual(["unit", "unit", "unit"]);
  expect(result.issues).toEqual([]);
});

test("keeps integration declarations, namespaces, named callbacks, and conditional factories", () => {
  const source =
    'import * as v from "vitest";\nfunction body() { expect(true).toBe(true); }\nv.test.runIf(true)("conditional", body);\nv.it("direct", () => {});\n';
  const result = extractTests("tests/integration/fixture.integration.test.ts", source);
  expect(result.tests).toHaveLength(2);
  expect(result.tests.every((item) => item.kind === "integration")).toBe(true);
  expect(result.tests[0]?.callback).toContain("function body()");
  expect(result.issues).toEqual([]);
});

test("does not mistake a shadowed test function or string fixture for a declaration", () => {
  const source =
    header +
    'function helper(test: (name: string, body: () => void) => void) { test("not vitest", () => {}); }\nconst fixture = \'test("text", () => {});\';\ntest("actual", () => { helper(() => {}); });\n';
  expect(extractTests("fixture.test.ts", source).tests).toHaveLength(1);
});

test("reports unresolvable callbacks rather than silently claiming complete coverage", () => {
  const source = header + 'test("dynamic", makeCallback());\ntest.todo("unfinished");\n';
  const result = extractTests("fixture.test.ts", source);
  expect(result.tests).toEqual([]);
  expect(result.issues).toHaveLength(2);
});

test("malformed classifier replies and failures are never clear verdicts", () => {
  const base = {
    api: "fixture",
    timestamp: 0,
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    answers: {},
  } satisfies ClassifierResult;
  expect(decision(base)).toBe("error");
  expect(decision({ ...base, stopReason: "error", errorMessage: "unavailable" })).toBe("error");
  expect(
    decision({
      ...base,
      answers: {
        coupling: {
          type: "choice",
          choice: "unknown",
          probabilities: { unknown: 1 },
          confidence: 1,
        },
      },
    }),
  ).toBe("unknown");
  expect(
    decision({
      ...base,
      answers: {
        coupling: {
          type: "choice",
          choice: "candidate",
          probabilities: { candidate: Number.NaN },
          confidence: 1,
        },
      },
    }),
  ).toBe("error");
});

test("handles timeout options and tagged parameter tables without extra requests", () => {
  const source =
    header + 'test("timeout", () => {}, 10_000);\ntest.each`value\n${1}`("table", value => {});\n';
  const result = extractTests("fixture.test.ts", source);
  expect(result.tests).toHaveLength(2);
  expect(result.issues).toEqual([]);
});
test("does not count intermediate conditional factories as unreviewed tests", () => {
  const result = extractTests(
    "fixture.test.ts",
    header + 'test.runIf(true).each([1])("case", () => {});\n',
  );
  expect(result.tests).toHaveLength(1);
  expect(result.issues).toEqual([]);
});
test("resolves namespace members structurally rather than treating identifiers as regex", () => {
  const result = extractTests(
    "fixture.test.ts",
    'import * as $v from "vitest";\n$v.test("one", () => {});\n$v["it"]("two", () => {});\n',
  );
  expect(result.tests).toHaveLength(2);
  expect(result.issues).toEqual([]);
});
const candidates = [{ id: "one", file: "fixture.test.ts", sourceHash: "saved" }];
const review = {
  id: "one",
  verdict: "false-positive",
  reason: "Preserves caller data.",
  evidence: [{ file: "fixture.test.ts", line: 4 }],
};

test("requires one evidence-backed review for every candidate", () => {
  expect(
    validateReviews(candidates, [review], new Map([["fixture.test.ts", "saved"]])),
  ).toMatchObject({ reviewed: 1, confirmed: 0, falsePositives: 1, needsContext: 0 });
  expect(() => validateReviews(candidates, [], new Map([["fixture.test.ts", "saved"]]))).toThrow(
    Error,
  );
  expect(() =>
    validateReviews(candidates, [review, review], new Map([["fixture.test.ts", "saved"]])),
  ).toThrow(Error);
  expect(() =>
    validateReviews(
      candidates,
      [{ ...review, evidence: [] }],
      new Map([["fixture.test.ts", "saved"]]),
    ),
  ).toThrow(Error);
});

test("rejects stale reviews and unrelated candidate IDs", () => {
  expect(() =>
    validateReviews(candidates, [review], new Map([["fixture.test.ts", "changed"]])),
  ).toThrow(Error);
  expect(() =>
    validateReviews(
      candidates,
      [{ ...review, id: "unrelated" }],
      new Map([["fixture.test.ts", "saved"]]),
    ),
  ).toThrow(Error);
});
