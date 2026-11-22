import { describe, expect, test } from "vitest";
import { markNullFields, NULL_FIELD, nullFieldsMessage } from "./null-fields.ts";
import { searchSchema } from "./search-parameters.ts";

describe("markNullFields", () => {
  test("an explicit null in a string field becomes the marker", () => {
    const marked = markNullFields(
      { query: "x", path: null, include: null, exclude: null },
      searchSchema,
    );
    expect(marked).toEqual({
      query: "x",
      path: NULL_FIELD,
      include: NULL_FIELD,
      exclude: NULL_FIELD,
    });
  });

  test("omitted and given fields stay as they are", () => {
    const omitted = { query: "x" };
    expect(markNullFields(omitted, searchSchema)).toBe(omitted);
    const given = { query: "x", path: "src", limit: 3 };
    expect(markNullFields(given, searchSchema)).toBe(given);
    expect(markNullFields(null, searchSchema)).toBeNull();
    expect(markNullFields("text", searchSchema)).toBe("text");
  });

  test("a null in a number or boolean field is invalid, because a marker cannot validate there", () => {
    expect(() => markNullFields({ query: "x", limit: null }, searchSchema)).toThrow(
      "limit is null",
    );
    expect(() => markNullFields({ query: "x", caseSensitive: null }, searchSchema)).toThrow(
      "caseSensitive is null",
    );
  });

  test("a null in an unknown field is invalid", () => {
    expect(() => markNullFields({ query: "x", other: null }, searchSchema)).toThrow(
      "other is null",
    );
  });
});

describe("nullFieldsMessage", () => {
  test("names every field that holds the marker", () => {
    expect(nullFieldsMessage({ query: "x", path: NULL_FIELD })).toMatch(/^path is null: /u);
    expect(nullFieldsMessage({ query: "x", path: NULL_FIELD, include: NULL_FIELD })).toMatch(
      /^path, include are null: /u,
    );
    expect(nullFieldsMessage({ query: "x", path: NULL_FIELD })).toContain(
      "failed or selected no text",
    );
  });

  test("says nothing about real values, and the marker is not a value a call can name", () => {
    expect(NULL_FIELD).toContain("\0");
    expect(nullFieldsMessage({ query: "x", path: "src", include: "", limit: 2 })).toBeUndefined();
    expect(nullFieldsMessage({ query: "x", path: [NULL_FIELD] })).toBeUndefined();
    expect(nullFieldsMessage({})).toBeUndefined();
  });
});
