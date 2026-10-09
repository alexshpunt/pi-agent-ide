import path from "node:path";
import type { ResultRange, ResolvedResultTargets } from "pi-agent-resource";
import { expect, test } from "vitest";
import { selectStructuralRegions } from "./selection.js";
import { publicRange } from "#src/selection-region.js";
import type { SelectOperation } from "#src/select-schema.js";

const enclosing: SelectOperation = {
  kind: "object",
  object: "function",
  relation: "enclosing",
  level: 1,
  extent: "around",
};
const body: SelectOperation = { kind: "part", part: "body" };

function input(source: string, text: string, extension = ".ts"): ResolvedResultTargets {
  const start = source.indexOf(text);
  if (start < 0) throw Error("Fixture seed missing");
  const point = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { lineNumber: before.length, column: before.at(-1)?.length ?? 0 };
  };
  return {
    complete: true,
    targets: [
      {
        source: path.resolve(`fixture${extension}`),
        expectedContent: source,
        ranges: [{ start: point(start), end: point(start + text.length) }],
      },
    ],
  };
}

const forms = [
  ["declaration", "async function task() { probe(); }", "{ probe(); }"],
  ["generator declaration", "function* task() { probe(); }", "{ probe(); }"],
  ["expression", "const task = function named() { probe(); };", "{ probe(); }"],
  ["generator expression", "const task = async function* named() { probe(); };", "{ probe(); }"],
  ["block arrow", "const task = async () => { probe(); };", "{ probe(); }"],
  ["expression arrow", "const task = () => probe();", "probe()"],
  ["object method", "const task = { async *run() { probe(); } };", "{ probe(); }"],
  ["class method", "class Task { static async run() { probe(); } }", "{ probe(); }"],
  ["getter", "const task = { get value() { return probe(); } };", "{ return probe(); }"],
  ["setter", "class Task { set value(v) { probe(); } }", "{ probe(); }"],
] as const;

for (const extension of [".js", ".ts"])
  test.each(forms)(
    `selects %s and its exact body in ${extension}`,
    async (_name, source, expected) => {
      const owners = await selectStructuralRegions(
        input(source, "probe()", extension),
        enclosing,
        process.cwd(),
      );
      expect(owners.regions).toHaveLength(1);
      const owner = owners.regions[0];
      if (!owner) throw Error("Missing owner");
      expect(owner.origins[0]?.expanded).toBe(true);
      const selected = await selectStructuralRegions(
        { complete: true, targets: [{ ...owner.target, ranges: [owner.range] }] },
        body,
        process.cwd(),
      );
      expect(selected.regions.map((region) => region.text)).toEqual([expected]);
    },
  );

test("preserves CRLF, emoji UTF-16 columns, EOF and exact function boundaries on one line", async () => {
  const source = '"😀"; function a() {\r\n probe();\r\n} function b() { other(); }';
  const selected = await selectStructuralRegions(
    input(source, "probe()"),
    enclosing,
    process.cwd(),
  );
  const owner = selected.regions[0];
  if (!owner) throw Error("Missing owner");
  expect(publicRange(owner.range)).toEqual({
    startLine: 1,
    startColumn: 6,
    endLine: 3,
    endColumn: 1,
  });
  expect(owner.text).toBe("function a() {\r\n probe();\r\n}");
  expect(owner.origins[0]?.range).toEqual({
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 8,
  });
  const eof = await selectStructuralRegions(input(source, "other()"), enclosing, process.cwd());
  expect(eof.regions[0]?.range.end.column).toBe(source.split("\n").at(-1)?.length);
});

test("uses source line coordinates for bare CR endings without normalizing bytes", async () => {
  const source = "function a() {\r probe();\r}\r";
  const seed = input(source, "probe()").targets[0];
  if (!seed) throw Error("Missing seed");
  const selected = await selectStructuralRegions(
    {
      complete: true,
      targets: [
        {
          ...seed,
          ranges: [{ start: { lineNumber: 2, column: 1 }, end: { lineNumber: 2, column: 8 } }],
        },
      ],
    },
    enclosing,
    process.cwd(),
  );
  expect(selected.regions[0]?.text).toBe("function a() {\r probe();\r}");
  expect(selected.regions[0]?.range.end).toEqual({ lineNumber: 3, column: 1 });
});
test("keeps outer callback calls and nested parameter defaults with their actual owners", async () => {
  const source = "function outer() { retry(() => probe()); function inner(v = retry()) {} }";
  const outer = await selectStructuralRegions(
    input(source, "retry(() => probe())"),
    enclosing,
    process.cwd(),
  );
  expect(outer.regions[0]?.text).toBe(source);
  const nestedSeed: ResultRange = {
    start: { lineNumber: 1, column: source.lastIndexOf("retry()") },
    end: { lineNumber: 1, column: source.lastIndexOf("retry()") + 7 },
  };
  const seedTarget = input(source, "retry()").targets[0];
  if (!seedTarget) throw Error("Missing nested seed");
  const nested = await selectStructuralRegions(
    {
      complete: true,
      targets: [{ ...seedTarget, ranges: [nestedSeed] }],
    },
    enclosing,
    process.cwd(),
  );
  expect(nested.regions[0]?.text).toBe("function inner(v = retry()) {}");
});

test("deduplicates owners without losing origins and keeps sparse files separate", async () => {
  const source = "function shared() { first(); second(); }";
  const a = input(source, "first()");
  const b = input(source, "second()");
  const secondFile = input("function separate() { first(); }", "first()", ".js");
  const selected = await selectStructuralRegions(
    { complete: false, targets: [...a.targets, ...b.targets, ...secondFile.targets] },
    enclosing,
    process.cwd(),
  );
  expect(selected.regions).toHaveLength(2);
  expect(selected.regions[0]?.origins).toHaveLength(2);
  expect(selected.regions[0]?.text).toBe(source);
});

test("rejects a seed that crosses one function boundary instead of reporting absence", async () => {
  const source = 'export function greet(value: string) { return value + " café"; }\r\n';
  await expect(
    selectStructuralRegions(input(source, source.trimEnd()), enclosing, process.cwd()),
  ).rejects.toThrow("narrower input");
});
test("returns valid absence for bodyless TS declarations and top-level calls", async () => {
  const source = "declare function task(value: number): void;";
  const owner = await selectStructuralRegions(input(source, "task"), enclosing, process.cwd());
  expect(owner.regions).toHaveLength(1);
  const exact = owner.regions[0];
  if (!exact) throw Error("Missing declaration");
  const selected = await selectStructuralRegions(
    { complete: true, targets: [{ ...exact.target, ranges: [exact.range] }] },
    body,
    process.cwd(),
  );
  expect(selected).toEqual({ regions: [], missingInputs: 1 });
  expect(
    await selectStructuralRegions(input("probe();", "probe()"), enclosing, process.cwd()),
  ).toEqual({ regions: [], missingInputs: 1 });
});

test.each([
  "interface Task { run(value: number): void; }",
  "abstract class Task { abstract run(value: number): void; }",
])("reports a supported bodyless method as absence: %s", async (source) => {
  const selected = await selectStructuralRegions(input(source, "run"), enclosing, process.cwd());
  const owner = selected.regions[0];
  if (!owner) throw Error("Missing method");
  const result = await selectStructuralRegions(
    { complete: true, targets: [{ ...owner.target, ranges: [owner.range] }] },
    body,
    process.cwd(),
  );
  expect(result).toEqual({ regions: [], missingInputs: 1 });
});

test("uses nested method ownership instead of its containing function", async () => {
  const source = "function outer() { const task = { run() { retry(); } }; }";
  const result = await selectStructuralRegions(input(source, "retry()"), enclosing, process.cwd());
  expect(result.regions.map((region) => region.text)).toEqual(["run() { retry(); }"]);
});
test("rejects partial part inputs, ambiguous whole seeds, unsupported languages and invalid syntax", async () => {
  await expect(
    selectStructuralRegions(input("function f() { probe(); }", "probe()"), body, process.cwd()),
  ).rejects.toThrow("Unsupported part body for call");
  const source = "function a() {} function b() {}";
  await expect(
    selectStructuralRegions(input(source, source), enclosing, process.cwd()),
  ).rejects.toThrow("separate constructs");
  await expect(
    selectStructuralRegions(input("probe()", "probe()", ".py"), enclosing, process.cwd()),
  ).rejects.toThrow("JavaScript and TypeScript");
  await expect(
    selectStructuralRegions(
      input("function broken( { probe();", "probe()"),
      enclosing,
      process.cwd(),
    ),
  ).rejects.toThrow("syntax provider reports errors");
  await expect(
    selectStructuralRegions(
      input("function f() {}", "f"),
      enclosing,
      process.cwd(),
      AbortSignal.abort(),
    ),
  ).rejects.toThrow(/abort/iu);
});
