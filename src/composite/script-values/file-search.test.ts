import { describe, expect, test } from "vitest";

import { fileSearchValue } from "./file-search.ts";
import { nullableValueSchema } from "./index.ts";

const input = (outcome: unknown) => ({ shown: "shown", outcome, content: [], details: {} });

describe("fileSearchValue", () => {
  test("resolves to the listed paths in their order", () => {
    const files = ["a.ts", "src/b.ts", "ssh://host/c.ts"];
    const outcome = { status: "success", data: { kind: "files", files, complete: true } };
    expect(fileSearchValue.project(input(outcome))).toEqual(files);
  });

  test("an empty list stays an empty list", () => {
    const outcome = { status: "success", data: { kind: "files", files: [], complete: true } };
    expect(fileSearchValue.project(input(outcome))).toEqual([]);
  });

  test("a result without its file list resolves to null, not the readable string", () => {
    expect(fileSearchValue.project(input(undefined))).toBeNull();
    const matches = { status: "success", data: { kind: "matches", files: ["a.ts"] } };
    expect(fileSearchValue.project(input(matches))).toBeNull();
  });

  test("declares a string array, or null for a failed call", () => {
    expect(nullableValueSchema(fileSearchValue)).toEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    });
  });
});
