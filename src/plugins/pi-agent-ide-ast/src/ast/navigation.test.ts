import path from "node:path";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { expect, test } from "vitest";
import { selectStructuralRegions } from "./selection.js";
import { SourceText } from "#src/source-text.js";
import type { StructuralSelectOperation } from "#src/select-schema.js";
import type { SelectedRegion } from "#src/selection-region.js";

function input(source: string, text = source, file = "navigation.ts"): ResolvedResultTargets {
  const start = source.indexOf(text);
  if (start < 0) throw Error("Missing seed");
  const lines = new SourceText(source);
  return {
    complete: true,
    targets: [
      {
        source: path.resolve(file),
        expectedContent: source,
        ranges: [{ start: lines.position(start), end: lines.position(start + text.length) }],
      },
    ],
  };
}
function selected(regions: readonly SelectedRegion[]): ResolvedResultTargets {
  return { complete: true, targets: regions.map((r) => ({ ...r.target, ranges: [r.range] })) };
}
async function run(source: string, seed: string, operation: StructuralSelectOperation) {
  return await selectStructuralRegions(input(source, seed), operation, process.cwd());
}

const nested = "function outer() { if (ready) { send(() => finish()); } other(); }";

test("enclosing levels count only the requested construct and include an exact seed", async () => {
  const result = await run(nested, "finish()", {
    kind: "object",
    object: "function",
    relation: "enclosing",
    level: 2,
    extent: "around",
  });
  expect(result.regions.map((r) => r.text)).toEqual([nested]);
  const call = await run(nested, "finish()", {
    kind: "object",
    object: "call",
    relation: "enclosing",
    level: 1,
    extent: "around",
  });
  expect(call.regions.map((r) => r.text)).toEqual(["finish()"]);
  expect(call.regions[0]?.origins[0]?.expanded).toBe(false);
  expect(
    await run(nested, "finish()", {
      kind: "object",
      object: "function",
      relation: "enclosing",
      level: 3,
      extent: "around",
    }),
  ).toEqual({ regions: [], missingInputs: 1 });
});

test("normalized parents skip parser wrappers and ancestors retain source order", async () => {
  const parent = await run(nested, "finish()", { kind: "navigate", relation: "parent" });
  expect(parent.regions.map((r) => r.text)).toEqual(["() => finish()"]);
  const ancestors = await run(nested, "finish()", { kind: "navigate", relation: "ancestors" });
  expect(ancestors.regions.map((r) => r.syntax?.object)).toEqual([
    "function",
    "if",
    "call",
    "function",
  ]);
  const functions = await run(nested, "finish()", {
    kind: "navigate",
    relation: "ancestors",
    object: "function",
  });
  expect(functions.regions.map((r) => r.text)).toEqual([nested, "() => finish()"]);
  const filteredParent = await run(nested, "finish()", {
    kind: "navigate",
    relation: "parent",
    object: "if",
  });
  expect(filteredParent.regions).toHaveLength(0);
});

test("children do not jump across constructs when a category filter is used", async () => {
  const children = await run(nested, nested, { kind: "navigate", relation: "children" });
  expect(children.regions.map((r) => r.syntax?.object)).toEqual(["if", "call"]);
  const filtered = await run(nested, nested, {
    kind: "navigate",
    relation: "children",
    object: "call",
  });
  expect(filtered.regions.map((r) => r.text)).toEqual(["other()"]);
  const descendants = await run(nested, nested, {
    kind: "navigate",
    relation: "descendants",
    object: "call",
  });
  expect(descendants.regions.map((r) => r.text)).toEqual([
    "send(() => finish())",
    "finish()",
    "other()",
  ]);
});

test("siblings follow source order and do not include the original construct", async () => {
  const source = "first(); second(); third();";
  for (const [direction, expected] of [
    ["previous", ["first()"]],
    ["next", ["third()"]],
    ["all", ["first()", "third()"]],
  ] as const) {
    const result = await run(source, "second()", {
      kind: "navigate",
      relation: "siblings",
      direction,
    });
    expect(result.regions.map((r) => r.text)).toEqual(expected);
  }
  expect(
    (
      await run(source, "first()", {
        kind: "navigate",
        relation: "siblings",
        direction: "previous",
      })
    ).missingInputs,
  ).toBe(1);
});

test("function parts preserve delimiters, defaults, expression bodies and bodyless absence", async () => {
  const source = "function f(x = nested()): number { return 1; }";
  for (const [part, expected] of [
    ["name", "f"],
    ["parameters", "(x = nested())"],
    ["returnType", ": number"],
    ["body", "{ return 1; }"],
  ] as const) {
    expect((await run(source, source, { kind: "part", part })).regions.map((r) => r.text)).toEqual([
      expected,
    ]);
  }
  const params = await run(source, source, { kind: "part", part: "parameters" });
  const descendants = await selectStructuralRegions(
    selected(params.regions),
    { kind: "navigate", relation: "descendants" },
    process.cwd(),
  );
  expect(descendants.regions.map((r) => r.text)).toEqual(["nested()"]);
  const arrow = "value => value + 1";
  expect(
    (await run(`const f = ${arrow};`, arrow, { kind: "part", part: "parameters" })).regions[0]
      ?.text,
  ).toBe("value");
  expect(
    (await run(`const f = ${arrow};`, arrow, { kind: "part", part: "body" })).regions[0]?.text,
  ).toBe("value + 1");
  const signature = "function f(): void;";
  expect(
    (await run(`declare ${signature}`, signature, { kind: "part", part: "body" })).missingInputs,
  ).toBe(1);
});

test("named part nodes remain navigable, including branch wrappers and exact scalar captures", async () => {
  const source = "if(ok) yes(); else no();";
  const branch = await run(source, source, { kind: "part", part: "else" });
  const calls = await selectStructuralRegions(
    selected(branch.regions),
    { kind: "navigate", relation: "children" },
    process.cwd(),
  );
  expect(calls.regions.map((r) => r.text)).toEqual(["no()"]);
  const loop = "while(ok) tick();";
  const body = await run(loop, loop, { kind: "part", part: "body" });
  expect(
    (
      await selectStructuralRegions(
        selected(body.regions),
        { kind: "navigate", relation: "children" },
        process.cwd(),
      )
    ).regions[0]?.text,
  ).toBe("tick()");
  const callee = await run("send(10)", "send(10)", { kind: "part", part: "callee" });
  expect(
    (
      await selectStructuralRegions(
        selected(callee.regions),
        { kind: "navigate", relation: "parent" },
        process.cwd(),
      )
    ).regions[0]?.text,
  ).toBe("send(10)");
  expect(
    (await run("const answer = 10;", "10", { kind: "navigate", relation: "parent" })).regions[0]
      ?.text,
  ).toBe("answer = 10");
});
const parts = [
  ["new Client(a)", "new Client(a)", "callee", "Client"],
  ["class C {}", "class C {}", "name", "C"],
  ["switch(v) {}", "switch(v) {}", "condition", "(v)"],
  ["for(let i=0;i<2;i++) tick();", "for(let i=0;i<2;i++) tick();", "initializer", "let i=0;"],
  ["for(let i=0;i<2;i++) tick();", "for(let i=0;i<2;i++) tick();", "condition", "i<2"],
  ["for(const item of items) tick();", "for(const item of items) tick();", "left", "item"],
  [
    "try {} finally { clean(); }",
    "try {} finally { clean(); }",
    "finalizer",
    "finally { clean(); }",
  ],
  ["try {} finally { clean(); }", "finally { clean(); }", "body", "{ clean(); }"],
  ["const name: number = 1;", "name: number = 1", "type", ": number"],
  ["const name: number = 1;", "name: number = 1", "name", "name"],
  ["total += count", "total += count", "left", "total"],
  ["const o={key:value};", "key:value", "value", "value"],
  ["send(a, b)", "send(a, b)", "callee", "send"],
  ["new Client(a)", "new Client(a)", "arguments", "(a)"],
  ["class C { method() {} }", "class C { method() {} }", "body", "{ method() {} }"],
  ["if (ok) yes(); else no();", "if (ok) yes(); else no();", "condition", "(ok)"],
  ["if (ok) yes(); else no();", "if (ok) yes(); else no();", "then", "yes();"],
  ["if (ok) yes(); else no();", "if (ok) yes(); else no();", "else", "else no();"],
  ["switch(v) { case 1: work(); }", "switch(v) { case 1: work(); }", "body", "{ case 1: work(); }"],
  ["for(let i=0;i<2;i++) tick();", "for(let i=0;i<2;i++) tick();", "update", "i++"],
  ["for(const item of items) tick();", "for(const item of items) tick();", "iterable", "items"],
  ["while(ok) tick();", "while(ok) tick();", "body", "tick();"],
  ["do tick(); while(ok);", "do tick(); while(ok);", "condition", "(ok)"],
  [
    "try { work(); } catch(e) { recover(); } finally { clean(); }",
    "try { work(); } catch(e) { recover(); } finally { clean(); }",
    "handler",
    "catch(e) { recover(); }",
  ],
  ["try {} catch(e) { recover(); }", "catch(e) { recover(); }", "parameter", "e"],
  ["const name: number = 1;", "name: number = 1", "value", "1"],
  ["total += count", "total += count", "right", "count"],
  ["const o = {key: value};", "key: value", "key", "key"],
  ["const o = {short};", "short", "value", "short"],
  ["return value;", "return value;", "value", "value"],
  ["throw error;", "throw error;", "value", "error"],
] as const;
test.each(parts)("extracts exact part %s / %s / %s", async (source, seed, part, expected) => {
  expect((await run(source, seed, { kind: "part", part })).regions.map((r) => r.text)).toEqual([
    expected,
  ]);
});

test("every normalized category appears in full-document navigation without invented array parts", async () => {
  const source =
    "class C { method() { const o={key: value}; const arr=[1]; target=value; if(ok) call(); switch(v) {} for(;;) run(); try {} catch(e) {} return new Result(); } } throw error;";
  const result = await run(source, source, { kind: "navigate", relation: "descendants" });
  expect(new Set(result.regions.map((r) => r.syntax?.object))).toEqual(
    new Set([
      "class",
      "function",
      "binding",
      "object",
      "property",
      "array",
      "assignment",
      "if",
      "call",
      "switch",
      "loop",
      "try",
      "catch",
      "return",
      "throw",
    ]),
  );
  await expect(run("const a=[1];", "[1]", { kind: "part", part: "arguments" })).rejects.toThrow(
    /unsupported.*part|supported parts/iu,
  );
});

test("optional absence is not an unsupported part or partial navigation input", async () => {
  expect(
    (await run("if(ok) yes();", "if(ok) yes();", { kind: "part", part: "else" })).missingInputs,
  ).toBe(1);
  expect(
    (await run("function f() {}", "function f() {}", { kind: "part", part: "returnType" }))
      .missingInputs,
  ).toBe(1);
  expect((await run("return;", "return;", { kind: "part", part: "value" })).missingInputs).toBe(1);
  await expect(run(nested, "fin", { kind: "navigate", relation: "children" })).rejects.toThrow(
    /exact.*node|enclosing/iu,
  );
  await expect(run("send()", "send()", { kind: "part", part: "body" })).rejects.toThrow(
    /supported parts/iu,
  );
});

test("structural chains retain sparse file associations and exact CRLF UTF-16 boundaries", async () => {
  const source = '"😀"; function f() {\r\n send(); other();\r\n}';
  const a = input(source, "send()"),
    b = input(source, "other()"),
    c = input("function g() { send(); }", "send()", "other.js");
  const owners = await selectStructuralRegions(
    { complete: false, targets: [...a.targets, ...b.targets, ...c.targets] },
    { kind: "object", object: "function", relation: "enclosing", level: 1, extent: "around" },
    process.cwd(),
  );
  expect(owners.regions).toHaveLength(2);
  expect(owners.regions[0]?.origins).toHaveLength(2);
  expect(owners.regions[0]?.range.start).toEqual({ lineNumber: 1, column: 6 });
  const bodies = await selectStructuralRegions(
    selected(owners.regions),
    { kind: "part", part: "body" },
    process.cwd(),
  );
  expect(bodies.regions[0]?.text).toBe("{\r\n send(); other();\r\n}");
});
