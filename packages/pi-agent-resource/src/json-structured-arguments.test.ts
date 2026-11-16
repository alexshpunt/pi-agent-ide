import { Type } from "typebox";
import { expect, test } from "vitest";
import { normalizeStructuredArguments } from "./json-structured-arguments.ts";

const reference = Type.Object({ id: Type.String() });
const source = Type.Union([Type.String(), reference]);
const sources = Type.Union([source, Type.Array(source)]);
const parameters = Type.Object({
  path: Type.Optional(sources),
  target: Type.Optional(sources),
  start: Type.Optional(source),
  end: Type.Optional(source),
  anchor: Type.Optional(source),
  targetStart: Type.Optional(source),
  targetEnd: Type.Optional(source),
  before: Type.Optional(
    Type.Union([source, Type.Object({ path: source, views: Type.Array(Type.String()) })]),
  ),
  after: Type.Optional(
    Type.Union([source, Type.Object({ path: source, views: Type.Array(Type.String()) })]),
  ),
  views: Type.Optional(Type.Array(Type.String())),
  content: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
});

for (const field of [
  "path",
  "target",
  "start",
  "end",
  "anchor",
  "targetStart",
  "targetEnd",
  "before",
  "after",
]) {
  test(`${field} accepts an object encoded as JSON text`, () => {
    const value = { id: "RESULT#00000000-0000-4000-8000-000000000000" };
    expect(normalizeStructuredArguments({ [field]: JSON.stringify(value) }, parameters)).toEqual({
      [field]: value,
    });
  });
}

for (const field of ["path", "target", "views"]) {
  test(`${field} accepts an array encoded as JSON text`, () => {
    const value = ["ssh://worker/project/a.ts", "ssh://worker/project/b.ts"];
    expect(normalizeStructuredArguments({ [field]: JSON.stringify(value) }, parameters)).toEqual({
      [field]: value,
    });
  });
}

test("nested supported fields and list members normalize without changing literal payloads", () => {
  const id = { id: "RESULT#00000000-0000-4000-8000-000000000000" };
  const input = {
    path: JSON.stringify([JSON.stringify(id), "a.txt"]),
    before: JSON.stringify({ path: JSON.stringify(id), views: '["anchors"]' }),
    after: { path: JSON.stringify(id), views: '["anchors"]' },
    content: '{ "amount": 1.0 }',
    text: '["literal"]',
    query: '{"id":"literal"}',
  };
  expect(normalizeStructuredArguments(input, parameters)).toEqual({
    ...input,
    path: [id, "a.txt"],
    before: { path: id, views: ["anchors"] },
    after: { path: id, views: ["anchors"] },
  });
  expect(input.path).toBe(JSON.stringify([JSON.stringify(id), "a.txt"]));
});

test.each([
  '{"id":',
  '["unterminated"',
  "plain.txt",
  "  {broken}  ",
  "null",
  "true",
  "123",
  '"a.txt"',
])("preserves plain, malformed, and scalar JSON strings: %s", (path) => {
  expect(normalizeStructuredArguments({ path }, parameters)).toEqual({ path });
});

test("only schema-supported composite types are decoded", () => {
  expect(
    normalizeStructuredArguments({ start: '["a","b"]', views: '{"id":"a"}' }, parameters),
  ).toEqual({ start: '["a","b"]', views: '{"id":"a"}' });
  expect(normalizeStructuredArguments({ path: '{"id":"[1,2]"}' }, parameters)).toEqual({
    path: { id: "[1,2]" },
  });
});

test("native values, unknown fields and object identity remain unchanged when no decoding is needed", () => {
  const input = { path: [{ id: "reference" }, "a.txt"], content: "[1,2]", extra: "[1,2]" };
  expect(normalizeStructuredArguments(input, parameters)).toBe(input);
});

test("decoded invalid objects retain their fields for ordinary tool validation", () => {
  expect(normalizeStructuredArguments({ path: '{"unexpected":1}' }, parameters)).toEqual({
    path: { unexpected: 1 },
  });
});
