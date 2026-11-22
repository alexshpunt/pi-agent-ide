import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResultTargetStore } from "./result-targets.ts";
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
test("source recovery respects existing literal paths and validates decoded values", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "json-sources-"));
  const store = new ResultTargetStore();
  const id = store.register(
    [
      {
        source: path.join(cwd, "a.txt"),
        expectedContent: "a",
        ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } }],
      },
    ],
    cwd,
  );
  const options = {
    cwd,
    sourceFields: ["path", "target"],
    resolveSource: (value: unknown) => store.source(value, cwd, true),
  };
  const array = '["a.txt","b.txt"]';
  const object = JSON.stringify({ id });
  try {
    expect(normalizeStructuredArguments({ path: array }, parameters, options)).toEqual({
      path: ["a.txt", "b.txt"],
    });
    expect(normalizeStructuredArguments({ path: object }, parameters, options)).toEqual({
      path: { id },
    });
    for (const literal of [array, object]) {
      writeFileSync(path.join(cwd, literal), "literal file");
      const input = { path: literal, target: literal };
      expect(normalizeStructuredArguments(input, parameters, options)).toBe(input);
    }
    for (const literal of [
      "[1,2]",
      '[{"id":"unissued"}]',
      '{"id":"unissued"}',
      '{"id":"checkout-5","feature":"legacyCheckout"}',
      JSON.stringify({ id, feature: "unsupported" }),
    ]) {
      const input = { path: literal };
      expect(normalizeStructuredArguments(input, parameters, options)).toBe(input);
    }
    const selector = {
      start: object,
      end: array,
      anchor: object,
      targetStart: object,
      targetEnd: array,
    };
    expect(normalizeStructuredArguments(selector, parameters, options)).toBe(selector);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
const sourceFields = [
  "path",
  "target",
  "start",
  "end",
  "anchor",
  "targetStart",
  "targetEnd",
  "before",
  "after",
];

test.each(
  [false, true].flatMap((multiline) => [false, true].map((indented) => ({ multiline, indented }))),
)("string-capable fields preserve literal JSON objects: %j", ({ multiline, indented }) => {
  const raw = JSON.stringify(
    { id: "checkout-5", feature: "legacyCheckout", retries: 3 },
    null,
    multiline ? 2 : undefined,
  );
  const literal = indented ? raw.replaceAll(/^/gm, "    ") : raw;
  for (const field of sourceFields) {
    const input = { [field]: literal };
    expect(normalizeStructuredArguments(input, parameters), field).toBe(input);
  }
});

for (const field of sourceFields) {
  test(`${field} preserves native references and JSON text containing id`, () => {
    const reference = { id: "RESULT#00000000-0000-4000-8000-000000000000" };
    const native = { [field]: reference };
    const literal = { [field]: JSON.stringify(reference) };
    expect(normalizeStructuredArguments(native, parameters)).toBe(native);
    expect(normalizeStructuredArguments(literal, parameters)).toBe(literal);
  });
}

for (const field of ["path", "target"]) {
  test(`${field} preserves native arrays and literal array strings`, () => {
    const value = ["ssh://worker/project/a.ts", "ssh://worker/project/b.ts"];
    const native = { [field]: value };
    const literal = { [field]: JSON.stringify(value) };
    expect(normalizeStructuredArguments(native, parameters)).toBe(native);
    expect(normalizeStructuredArguments(literal, parameters)).toBe(literal);
  });
}

test("nested structured slots decode without changing string-capable members or payloads", () => {
  const id = { id: "RESULT#00000000-0000-4000-8000-000000000000" };
  const input = {
    path: [JSON.stringify(id), id, "a.txt"],
    before: JSON.stringify({ path: id, views: ["anchors"] }),
    after: { path: JSON.stringify(id), views: '["anchors"]' },
    views: '["anchors"]',
    content: '{ "amount": 1.0 }',
    text: '["literal"]',
    query: '{"id":"literal"}',
  };
  expect(normalizeStructuredArguments(input, parameters)).toEqual({
    ...input,
    after: { path: JSON.stringify(id), views: ["anchors"] },
    views: ["anchors"],
  });
  expect(input.after.views).toBe('["anchors"]');
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

test("only schema-supported composite-only types are decoded", () => {
  const schema = Type.Object({ object: reference, array: Type.Array(Type.String()) });
  expect(
    normalizeStructuredArguments({ object: '{"id":"[1,2]"}', array: '["a","b"]' }, schema),
  ).toEqual({ object: { id: "[1,2]" }, array: ["a", "b"] });
  const unsupported = { object: '["a","b"]', array: '{"id":"a"}' };
  expect(normalizeStructuredArguments(unsupported, schema)).toBe(unsupported);
  for (const value of ['{"id":', '["unterminated"']) {
    const input = { object: value, array: value };
    expect(normalizeStructuredArguments(input, schema)).toBe(input);
  }
});

test("native values, unknown fields and object identity remain unchanged when no decoding is needed", () => {
  const input = { path: [{ id: "reference" }, "a.txt"], content: "[1,2]", extra: "[1,2]" };
  expect(normalizeStructuredArguments(input, parameters)).toBe(input);
});

test("decoded invalid objects retain their fields for ordinary tool validation", () => {
  expect(
    normalizeStructuredArguments(
      { object: '{"unexpected":1}' },
      Type.Object({ object: reference }),
    ),
  ).toEqual({ object: { unexpected: 1 } });
});
