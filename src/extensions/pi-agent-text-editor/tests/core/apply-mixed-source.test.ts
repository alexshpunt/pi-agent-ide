import { expect, test } from "vitest";
import {
  parseApplyCalls,
  createApplySourceProjection,
  compactApplySource,
} from "#src/core/apply/mixed-source.js";

test("recognizes unfinished create arguments without exposing large text bodies", () => {
  const source = 'createFile("src/a.ts", "' + "x".repeat(10_000);
  const calls = parseApplyCalls(source);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "createFile", from: 0, to: source.length });
  expect(JSON.stringify(calls).length).toBeLessThan(500);
});

test("recognizes transactional editor helpers", () => {
  const source = 'open("a.ts"); copyFile("a.ts", "b.ts"); apply();';
  expect(parseApplyCalls(source).map(({ name }) => name)).toEqual(["open", "copyFile", "apply"]);
  expect(compactApplySource(source)).toContain("apply(");
});

test("excludes comments strings and member methods", () => {
  const source = '// open(\nconst text = "apply("; file.replace(selection, value); open(path);';
  const calls = parseApplyCalls(source);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "open" });
});

test("does not identify locally shadowed helper names as IDE calls", () => {
  expect(parseApplyCalls('function f(open) { open("a"); }')).toEqual([]);
});

test("a parameter shadows calls only inside its function", () => {
  const calls = parseApplyCalls('function f(open) { open("local"); } open("real");');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("open");
});

test("unterminated path literals are not advertised as complete values", () => {
  expect(parseApplyCalls('read({path: "partial')[0]?.path?.literal).toBe(false);
});

test("long paths stay visibly incomplete rather than looking like exact values", () => {
  const source = 'read({path: "' + "x".repeat(1000) + '"})';
  const path = parseApplyCalls(source)[0]?.path;
  expect(path?.text).toContain("…");
  expect(path?.text.length).toBeLessThan(200);
});

test("preserves search identity", () => {
  expect(parseApplyCalls('search({query: "needle", path: base})')).toMatchObject([
    { query: { text: '"needle"', literal: true }, path: { text: "base", literal: false } },
  ]);
});

test("every prefix of a long create stays compact and stable", () => {
  const project = createApplySourceProjection();
  const source = 'if (ready) { createFile("a", "' + "x".repeat(2048) + '"); }';
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    const output = project(prefix);
    expect(output.length).toBeLessThan(300);
    expect(project(prefix)).toBe(output);
  }
});

test("uncertain long source has a bounded preview without inventing a tool call", () => {
  const project = createApplySourceProjection();
  const output = project('const payload = "' + "x".repeat(5000));
  expect(output.length).toBeLessThan(300);
  expect(output).toContain("…");
});

test("var hoisting and helper reassignment are not mistaken for IDE calls", () => {
  expect(
    parseApplyCalls('function f() { if (ok) { var read = local; } read({path:"x"}); }'),
  ).toEqual([]);
  expect(parseApplyCalls("apply = custom; apply();")).toEqual([]);
});

test("explicit result values use a compact helper preview", () => {
  const source = "result({verified: true, count: 42});";
  const calls = parseApplyCalls(source);
  expect(calls).toMatchObject([
    { name: "result", arguments: { verified: { text: "true" }, count: { text: "42" } } },
  ]);
  expect(compactApplySource(source, calls, () => "result verified: true · count: 42")).toBe(
    "result verified: true · count: 42;",
  );
});

test("bounds long object arguments", () => {
  const call = parseApplyCalls(
    'search({path:"a",query:"' + "x".repeat(2000) + '", custom: options})',
  )[0];
  expect(call?.arguments.query?.text.length).toBeLessThan(200);
  expect(call?.arguments.custom).toEqual({ text: "options", literal: false });
});

test("recognizes result as a compact Apply helper", () => {
  const source = "const value = compute();\nresult({ value, count: 42 });";
  const calls = parseApplyCalls(source);
  expect(calls).toMatchObject([
    {
      name: "result",
      arguments: { value: { text: "value", literal: false }, count: { text: "42" } },
    },
  ]);
  expect(compactApplySource(source, calls, (call) => `[${call.name}]`)).toContain("[result]");
});
