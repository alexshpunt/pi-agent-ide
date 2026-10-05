import path from "node:path";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { expect, test } from "vitest";
import { SourceText } from "#src/source-text.js";
import { selectStructuralRegions } from "./selection.js";

function input(source: string, seed: string, file = "list.ts"): ResolvedResultTargets {
  const start = source.lastIndexOf(seed);
  if (start < 0) throw Error("Missing seed");
  const text = new SourceText(source);
  return {
    complete: true,
    targets: [
      {
        source: path.resolve(file),
        expectedContent: source,
        ranges: [{ start: text.position(start), end: text.position(start + seed.length) }],
      },
    ],
  };
}
async function extent(
  source: string,
  seed: string,
  mode: "inside" | "around" = "around",
  file?: string,
) {
  return await selectStructuralRegions(
    input(source, seed, file),
    { kind: "elementExtent", extent: mode },
    process.cwd(),
  );
}

for (const [name, interior, seed, expected] of [
  ["first", " a, b, c ", "a", "a, "],
  ["middle", " a, b, c ", "b", "b, "],
  ["last", " a, b, c ", "c", ", c"],
  ["only", " a ", "a", " a "],
  ["last trailing", " a, b, c, ", "c", "c, "],
  ["only trailing", " a, ", "a", " a, "],
  ["multiline first", "\r\n  a,\r\n  b\r\n", "a", "a,\r\n  "],
  ["multiline last", "\r\n  a,\r\n  b\r\n", "b", ",\r\n  b"],
  ["multiline trailing", "\r\n  a,\r\n  b,\r\n", "b", "b,\r\n"],
  ["multiline only", "\r\n  a\r\n", "a", "\r\n  a\r\n"],
] as const) {
  for (const list of ["arguments", "parameters"] as const) {
    test(`${list}: ${name} owns exact separator and whitespace`, async () => {
      const source = list === "arguments" ? `f(${interior});` : `function f(${interior}) {}`;
      const result = await extent(source, seed);
      expect(result.regions.map((r) => r.text)).toEqual([expected]);
      expect(result.regions[0]?.origins[0]?.expanded).toBe(true);
      const inside = await extent(source, seed, "inside");
      expect(inside.regions.map((r) => r.text)).toEqual([seed]);
      expect(inside.regions[0]?.origins[0]?.expanded).toBe(false);
    });
  }
}

test("JS and TS parameters retain defaults, rest patterns, types and internal comments", async () => {
  for (const [file, source, seed, expected] of [
    [
      "list.ts",
      "function f(a: T, b = { /* inside */ x: 1 }, ...rest: R[]) {}",
      "b = { /* inside */ x: 1 }",
      "b = { /* inside */ x: 1 }, ",
    ],
    ["list.js", "const f = (a, ...rest) => rest;", "...rest", ", ...rest"],
    ["list.ts", "class C { method(a: T, b?: U) {} }", "b?: U", ", b?: U"],
    ["list.ts", "function f(this: C, a: T): void;", "this: C", "this: C, "],
  ] as const)
    expect((await extent(source, seed, "around", file)).regions.map((r) => r.text)).toEqual([
      expected,
    ]);
});

test("nested lists derive commas only from the direct list, not commas inside an expression", async () => {
  const source = 'f(g(a, b), "x,y", () => { /* inside */ return 1; });';
  expect((await extent(source, "g(a, b)")).regions.map((r) => r.text)).toEqual(["g(a, b), "]);
  expect((await extent(source, '"x,y"')).regions.map((r) => r.text)).toEqual(['"x,y", ']);
  expect((await extent(source, "a")).regions.map((r) => r.text)).toEqual(["a, "]);
  expect(
    (await extent(source, "() => { /* inside */ return 1; }")).regions.map((r) => r.text),
  ).toEqual([", () => { /* inside */ return 1; }"]);
  expect((await extent("new C(a, b)", "a")).regions.map((r) => r.text)).toEqual(["a, "]);
});

for (const [source, seed] of [
  ["f(/* before */ a, b)", "a"],
  ["f(a /* note */, b)", "a"],
  ["f(a, /* note */ b)", "a"],
  ["f(a, /* before element */ b)", "b"],
  ["f(a, b /* closing */)", "b"],
  ["f(a, b, /* trailing */)", "b"],
  ["function f(a, // next\n b) {}", "a"],
] as const)
  test(`refuses ambiguous adjacent comments: ${source}`, async () => {
    await expect(extent(source, seed)).rejects.toThrow(/comment|trivia/iu);
    expect((await extent(source, seed, "inside")).regions.map((r) => r.text)).toEqual([seed]);
  });

for (const [source, seed] of [
  ["f(alpha, b)", "lph"],
  ["f(a, b)", "a, b"],
  ["f({ key: value }, b)", "value"],
  ["const a = [first, second]", "first"],
  ["const a = {first: value, second: other}", "first: value"],
  ["const f = value => value", "value"],
  ["function f(a: T) {}", "a"],
] as const)
  test(`refuses non-element or partial seeds: ${source} / ${seed}`, async () => {
    await expect(extent(source, seed)).rejects.toThrow(/exact|element|list/iu);
  });

test("keeps sparse files and repeated input associations without using array position as identity", async () => {
  const one = input("f(a, b, c)", "b", "one.js");
  const two = input("f(x, y)", "y", "two.js");
  const result = await selectStructuralRegions(
    { complete: false, targets: [...two.targets, ...one.targets, ...one.targets] },
    { kind: "elementExtent", extent: "around" },
    process.cwd(),
  );
  expect(result.regions.map((r) => r.text)).toEqual([", y", "b, "]);
  expect(result.regions.map((r) => path.basename(r.target.source))).toEqual(["two.js", "one.js"]);
  expect(result.missingInputs).toBe(0);
});
