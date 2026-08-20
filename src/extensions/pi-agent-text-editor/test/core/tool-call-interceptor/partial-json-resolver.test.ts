import { requiredValue } from "../../../../../utils/required-value.js";
import { describe, expect, it } from "vitest";

import { resolvePartial } from "#src/core/tool-call-interceptor/partial-json-resolver.js";
// ─── Helper ───────────────────────────────────────────────────────────────

function editsOf(json: string): Array<Record<string, unknown>> | undefined {
  const parsed = resolvePartial(json);
  if (!parsed) {
    return undefined;
  }
  const e = parsed.edits;
  return Array.isArray(e) ? (e as Array<Record<string, unknown>>) : undefined;
}

function writesOf(json: string): Array<Record<string, unknown>> | undefined {
  const parsed = resolvePartial(json);
  if (!parsed) {
    return undefined;
  }
  const w = parsed.writes;
  return Array.isArray(w) ? (w as Array<Record<string, unknown>>) : undefined;
}

describe("resolvePartial", () => {
  // ─── Empty / invalid ────────────────────────────────────────────────

  it("returns undefined for empty string", () => {
    expect(resolvePartial("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only", () => {
    expect(resolvePartial("   ")).toBeUndefined();
  });

  it("returns undefined for garbage", () => {
    expect(resolvePartial("not even close to json")).toBeUndefined();
  });

  it("returns undefined for atomic value (string)", () => {
    expect(resolvePartial('"just a string"')).toBeUndefined();
  });

  it("returns undefined for atomic value (number)", () => {
    expect(resolvePartial("42")).toBeUndefined();
  });

  it("returns undefined for array (not object)", () => {
    expect(resolvePartial("[1, 2, 3]")).toBeUndefined();
  });

  it("returns empty object for just opening brace", () => {
    expect(resolvePartial("{")).toEqual({});
  });

  it("returns empty object for empty object", () => {
    expect(resolvePartial("{}")).toEqual({});
  });

  // ─── Complete JSON ──────────────────────────────────────────────────

  it("parses a complete JSON object", () => {
    const result = resolvePartial('{"key": "value", "num": 42}');
    expect(result).toEqual({ key: "value", num: 42 });
  });

  it("parses a complete JSON with edits array", () => {
    const json = JSON.stringify({
      edits: [
        { path: "a.ts", start: "begin", end: "end", text: "content" },
        { path: "b.ts", start: "1#ABCD", end: "50#EFGH", text: "other" },
      ],
    });
    const edits = editsOf(json);
    expect(edits).toHaveLength(2);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts", start: "begin" });
    expect(requiredValue(edits)[1]).toMatchObject({ path: "b.ts", start: "1#ABCD" });
  });

  // ─── Partial: object still streaming ────────────────────────────────

  it("parses object with partial string value", () => {
    const result = resolvePartial('{"key": "partial');
    expect(result).toEqual({ key: "partial" });
  });

  it("parses object with partial array", () => {
    const result = resolvePartial('{"arr": [1, 2, 3');
    expect(result).toEqual({ arr: [1, 2, 3] });
  });

  it("parses object with partial nested object", () => {
    const result = resolvePartial('{"obj": {"inner": "val"');
    expect(result).toEqual({ obj: { inner: "val" } });
  });

  // ─── Partial: edits array with mixed complete/incomplete objects ────

  it("extracts objects from array with one complete + one incomplete", () => {
    const json =
      '{"edits":[{"path":"a.ts","start":"begin","end":"end","text":"ok"},{"path":"b.ts","start":"1#ABCD"';
    const edits = editsOf(json);
    expect(edits).toHaveLength(2);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts", start: "begin" });
    expect(requiredValue(edits)[1]).toMatchObject({ path: "b.ts", start: "1#ABCD" });
  });

  it("extracts objects when second is barely started", () => {
    const json = '{"edits":[{"path":"a.ts","start":"begin","end":"end","text":"ok"},{"path":"b.ts"';
    const edits = editsOf(json);
    expect(edits).toHaveLength(2);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts" });
    expect(requiredValue(edits)[1]).toMatchObject({ path: "b.ts" });
  });

  it("extracts objects from partial edits array before closing bracket", () => {
    const json = '{"edits":[{"path":"a.ts","start":"begin","end":"end","text":"ok"}';
    const edits = editsOf(json);
    expect(edits).toHaveLength(1);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts" });
  });

  it("extracts multiple complete objects from partial array", () => {
    const json =
      '{"edits":[{"path":"a.ts","start":"begin","end":"end","text":"ok"},{"path":"b.ts","start":"2#AAAA","end":"10#BBBB","text":"more"}';
    const edits = editsOf(json);
    expect(edits).toHaveLength(2);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts" });
    expect(requiredValue(edits)[1]).toMatchObject({ path: "b.ts" });
  });

  // ─── Special characters in strings ──────────────────────────────────

  it("handles braces inside strings", () => {
    const json = '{"text": "this has { and } inside"}';
    const result = resolvePartial(json);
    expect(result).toEqual({ text: "this has { and } inside" });
  });

  it("handles partial string with braces", () => {
    const json = '{"text": "this has {';
    const result = resolvePartial(json);
    expect(result).toEqual({ text: "this has {" });
  });

  it("handles escaped quotes inside strings", () => {
    const json = '{"text": "he said \\"hello\\""}';
    const result = resolvePartial(json);
    expect(result).toEqual({ text: 'he said "hello"' });
  });

  it("handles partial string with escape", () => {
    const json = '{"text": "he said \\"';
    const result = resolvePartial(json);
    expect(result).toEqual({ text: 'he said "' });
  });

  it("handles unicode escapes", () => {
    const json = '{"msg": "hello\\u0041"}';
    const result = resolvePartial(json);
    expect(result).toEqual({ msg: "helloA" });
  });

  // ─── writes array (write tool structure) ────────────────────────────

  it("extracts from writes array", () => {
    const json = '{"writes":[{"path":"a.ts","content":"..."},{"path":"b.ts","content":"..."}';
    const writes = writesOf(json);
    expect(writes).toHaveLength(2);
    expect(requiredValue(writes)[0]).toMatchObject({ path: "a.ts" });
    expect(requiredValue(writes)[1]).toMatchObject({ path: "b.ts" });
  });

  it("extracts from single write entry (partial)", () => {
    const json = '{"writes":[{"path":"a.ts","content":"hello';
    const writes = writesOf(json);
    expect(writes).toHaveLength(1);
    expect(requiredValue(writes)[0]).toMatchObject({ path: "a.ts", content: "hello" });
  });

  // ─── No array key yet ───────────────────────────────────────────────

  it("returns object when edits array not yet started", () => {
    const result = resolvePartial('{"other": "data"');
    expect(result).toEqual({ other: "data" });
  });

  it("returns empty object for just a key", () => {
    expect(resolvePartial('{"edits"')).toEqual({});
  });

  it("returns empty object for key with colon but no value", () => {
    expect(resolvePartial('{"edits":')).toEqual({});
  });

  it("returns object with empty array for edits array with no elements", () => {
    expect(resolvePartial('{"edits":[')).toEqual({ edits: [] });
  });

  // ─── Multiple top-level keys ────────────────────────────────────────

  it("extracts multiple top-level keys (partial)", () => {
    const json = '{"path":"a.ts","start":"begin","end":"end"';
    const result = resolvePartial(json);
    expect(result).toMatchObject({ path: "a.ts", start: "begin", end: "end" });
  });

  // ─── Deep nesting ───────────────────────────────────────────────────

  it("handles deeply nested objects", () => {
    const json = '{"level1":{"level2":{"level3":"deep"';
    const result = resolvePartial(json);
    expect(result).toMatchObject({ level1: { level2: { level3: "deep" } } });
  });

  it("handles nested arrays inside edits", () => {
    const json = '{"edits":[{"path":"a.ts","tags":["one","two","three"]';
    const edits = editsOf(json);
    expect(edits).toHaveLength(1);
    expect(requiredValue(edits)[0]).toMatchObject({ path: "a.ts", tags: ["one", "two", "three"] });
  });

  // ─── Number and boolean fields ──────────────────────────────────────

  it("extracts number and boolean fields", () => {
    const json = '{"count":5,"active":true}';
    const result = resolvePartial(json);
    expect(result).toEqual({ count: 5, active: true });
  });

  it("extracts with partial number", () => {
    const json = '{"value": 42';
    const result = resolvePartial(json);
    expect(result).toEqual({ value: 42 });
  });

  // ─── Null values ────────────────────────────────────────────────────

  it("extracts null values", () => {
    const json = '{"nullable": null}';
    const result = resolvePartial(json);
    expect(result).toEqual({ nullable: null });
  });
});
