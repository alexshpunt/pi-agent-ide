import { describe, expect, test } from "vitest";

import { nullableValueSchema } from "./index.ts";
import { semanticSearchValue } from "./semantic-search.ts";

const input = (outcome: unknown) => ({ shown: "shown", outcome, content: [], details: {} });

describe("semanticSearchValue", () => {
  test("resolves to the ranked files without ranges", () => {
    const outcome = { status: "success", data: { files: ["b.ts", "a.ts"] } };
    expect(semanticSearchValue.project(input(outcome))).toEqual(["b.ts", "a.ts"]);
  });

  test("a result without its files resolves to null, not the readable string", () => {
    expect(semanticSearchValue.project(input({ status: "success", data: "text" }))).toBeNull();
  });

  test("declares a string array, or null for a failed call", () => {
    expect(nullableValueSchema(semanticSearchValue)).toEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    });
  });
});
