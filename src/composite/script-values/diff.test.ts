import { describe, expect, test } from "vitest";

import { createUnifiedDiff } from "#src/extensions/pi-agent-text-editor/src/core/mutation-result/diff.ts";
import { diffValue } from "./diff.ts";
import { nullableValueSchema } from "./index.ts";

const input = (details: unknown) => ({
  shown: "<system-result>…</system-result>\nbounded diff",
  outcome: { status: "success", data: {} },
  content: [],
  details,
});

describe("diffValue", () => {
  test("different sources resolve to the complete unified diff", () => {
    // Longer than the 2000 lines a direct call shows.
    const added = Array.from({ length: 3000 }, (_, index) => `new ${index}\n`).join("");
    const { diff } = createUnifiedDiff("a.txt", "head\n", `head\n${added}`, "b.txt");
    const value = diffValue.project(input({ comparison: { equal: false, diff } }));
    expect(value).toBe(diff);
    expect(typeof value === "string" && value.split("\n")).toEqual([
      "--- a.txt",
      "+++ b.txt",
      "@@ -1,1 +1,3001 @@",
      " head",
      ...Array.from({ length: 3000 }, (_, index) => `+new ${index}`),
    ]);
  });

  test("equal sources resolve to an empty string", () => {
    const { diff } = createUnifiedDiff("a.txt", "same\n", "same\n", "b.txt");
    expect(diffValue.project(input({ comparison: { equal: true, diff } }))).toBe("");
  });

  test("a result without its comparison resolves to the readable result", () => {
    expect(diffValue.project(input({}))).toBe(input({}).shown);
  });

  test("the declared value is a string or null", () => {
    expect(nullableValueSchema(diffValue)).toEqual({
      anyOf: [{ type: "string", description: expect.any(String) }, { type: "null" }],
    });
  });
});
