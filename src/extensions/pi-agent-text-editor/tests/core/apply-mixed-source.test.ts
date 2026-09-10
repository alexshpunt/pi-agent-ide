import { expect, test } from "vitest";
import {
  parseApplyCalls,
  createApplySourceProjection,
  compactApplySource,
} from "#src/core/apply/mixed-source.js";

test("recognizes unfinished helper arguments without exposing large text bodies", () => {
  const source = 'replace({path: "src/a.ts", text: "' + "x".repeat(10000);
  const calls = parseApplyCalls(source);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    name: "replace",
    from: 0,
    to: source.length,
    path: { text: '"src/a.ts"', literal: true },
  });
  expect(JSON.stringify(calls).length).toBeLessThan(500);
});

test("distinguishes expressions from literals and excludes comments, strings and members", () => {
  const source =
    '// replace(\nconst text = "read("; obj.read({}); replace({path: doc.source, text: value';
  const calls = parseApplyCalls(source);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "replace", path: { text: "doc.source", literal: false } });
});

test("does not identify locally shadowed helper names as IDE calls", () => {
  expect(parseApplyCalls('function f(replace) { replace({path: "a"}); }')).toEqual([]);
});

test("a parameter shadows calls only inside its function", () => {
  const source = 'function f(replace) { replace({path:"local"}); } replace({path:"real"});';
  const calls = parseApplyCalls(source);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path?.text).toBe('"real"');
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

test("preserves query and target identity without exposing mutation text", () => {
  expect(
    parseApplyCalls(
      'search({query: "needle", path: base}); copy({path:"a", target: dest, targetStart:"end"})',
    ),
  ).toMatchObject([
    { query: { text: '"needle"', literal: true }, path: { text: "base", literal: false } },
    { path: { text: '"a"' }, target: { text: "dest", literal: false } },
  ]);
});

test("every prefix of a long argument stays compact and repeated paints are stable", () => {
  const project = createApplySourceProjection();
  const source = 'if (ready) { replace({path:"a", text:"' + "x".repeat(2048) + '"}); }';
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    const output = project(prefix);
    expect(output.length).toBeLessThan(200);
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
  expect(parseApplyCalls('replace = custom; replace({path:"x"});')).toEqual([]);
});

test("explicit result values remain visible as source instead of a collapsed tool header", () => {
  const source = "result({verified: true, count: 42});";
  expect(parseApplyCalls(source)).toEqual([]);
  expect(compactApplySource(source)).toBe(source);
});

test("retains anchors and all argument expressions while bounding replacement text", () => {
  const call = parseApplyCalls(
    'replace({path:"a",start:"12#ABCD",end:"18#1234",text:"' +
      "x".repeat(2000) +
      '", custom: options})',
  )[0];
  expect(call?.arguments.start?.text).toBe('"12#ABCD"');
  expect(call?.arguments.end?.text).toBe('"18#1234"');
  expect(call?.arguments.text?.text.length).toBeLessThan(200);
  expect(call?.arguments.custom).toEqual({ text: "options", literal: false });
});
