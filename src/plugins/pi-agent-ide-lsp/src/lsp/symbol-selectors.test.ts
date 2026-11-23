import { expect, test } from "vitest";

import {
  bodyEntry,
  declarationsForWorkspaceSymbol,
  declarationsNamed,
  normalizeDocumentSymbols,
  resolveSymbolDeclaration,
} from "./symbol-selectors.ts";

import type { LspDocumentSymbol } from "./symbols.ts";

const sourceLines = [
  "inline int clamp(int v, int lo, int hi);",
  "inline Vec clamp(const Vec& v, float lo, float hi);",
  "inline float lerp(float a, float b, float t);",
  "struct Box {",
  "  int get() const;",
  "  int get();",
  "  int operator()(int index) const;",
  "  void apply(std::function<void(int)> f, std::map<int, int> t);",
  "};",
  "",
  "inline int clamp(int v, int lo, int hi) {",
  "  return v < lo ? lo : v > hi ? hi : v;",
  "}",
  "inline Vec clamp(const Vec& v, float lo, float hi) {",
  "  return v;",
  "}",
  "inline float lerp(float a, float b, float t) { return a + (b - a) * t; }",
  "template <typename T> T twice(T value) { return value + value; }",
];
const text = sourceLines.join("\n");

/** A symbol whose name starts at `column` of `line` and whose range ends with `lastLine`. */
function entry(
  name: string,
  detail: string,
  line: number,
  column: number,
  kind = 12,
  children?: LspDocumentSymbol[],
  lastLine = line,
): LspDocumentSymbol {
  return {
    name,
    kind,
    detail,
    range: {
      start: { line, character: 0 },
      end: { line: lastLine, character: sourceLines[lastLine]?.length ?? 0 },
    },
    selectionRange: {
      start: { line, character: column },
      end: { line, character: column + name.length },
    },
    ...(children && { children }),
  };
}

// Shapes clangd 18 reports: a prototype and its definition are two entries with one signature.
const symbols = normalizeDocumentSymbols([
  entry("clamp", "int (int, int, int)", 0, 11),
  entry("clamp", "Vec (const Vec &, float, float)", 1, 11),
  entry("lerp", "float (float, float, float)", 2, 13),
  entry("Box", "struct", 3, 7, 5, [
    entry("get", "int () const", 4, 6, 6),
    entry("get", "int ()", 5, 6, 6),
    entry("operator()", "int (int) const", 6, 6, 6),
    entry("apply", "void (std::function<void (int)>, std::map<int, int>)", 7, 7, 6),
  ]),
  entry("clamp", "int (int, int, int)", 10, 11, 12, undefined, 12),
  entry("clamp", "Vec (const Vec &, float, float)", 13, 11, 12, undefined, 15),
  entry("lerp", "float (float, float, float)", 16, 13),
  entry("twice", "template T (T)", 17, 22),
]);
const lines = (selector: string | readonly string[]) =>
  resolveSymbolDeclaration(
    symbols,
    typeof selector === "string" ? selector.split("/") : selector,
    "main.cpp",
  ).map((symbol) => symbol.selectionRange.start.line + 1);

test("a prototype and its definition are one declaration", () => {
  expect(lines(["lerp"])).toEqual([3, 17]);
  expect(lines(["twice"])).toEqual([18]);
});

test("parameter types name one overload in any spelling clangd's signature allows", () => {
  expect(lines(["clamp(int, int, int)"])).toEqual([1, 11]);
  expect(lines(["clamp(int,int,int)"])).toEqual([1, 11]);
  expect(lines(["clamp(const Vec&, float, float)"])).toEqual([2, 14]);
  expect(lines(["clamp(const Vec &,float,float)"])).toEqual([2, 14]);
  // Parameter names and defaults copied from a declaration are ignored.
  expect(lines(["clamp(const Vec& v, float lo = 0, float hi)"])).toEqual([2, 14]);
  expect(lines(["clamp (int v, int lo, int hi)"])).toEqual([1, 11]);
  expect(lines("Box/apply(std::function<void(int)>, std::map<int, int>)")).toEqual([8]);
});

test("trailing qualifiers tell methods apart, and no qualifier selects the unqualified one", () => {
  expect(lines("Box/get() const")).toEqual([5]);
  expect(lines("Box/get()")).toEqual([6]);
  expect(lines(["get(void)"])).toEqual([6]);
  expect(lines("Box/operator()")).toEqual([7]);
  expect(lines("Box/operator()(int)")).toEqual([7]);
});

test("canonical selectors carry the signature only where a name has several declarations", () => {
  expect(declarationsNamed(symbols, "clamp").map((group) => group[0]?.selector)).toEqual([
    ["clamp(int, int, int)"],
    ["clamp(const Vec&, float, float)"],
  ]);
  expect(declarationsNamed(symbols, "lerp")[0]?.[0]?.selector).toEqual(["lerp"]);
  expect(declarationsNamed(symbols, "get").map((group) => group[0]?.selector)).toEqual([
    ["Box", "get() const"],
    ["Box", "get()"],
  ]);
  for (const group of declarationsNamed(symbols, "clamp"))
    expect(lines(group[0]?.selector ?? [])).toEqual(
      group.map((s) => s.selectionRange.start.line + 1),
    );
});

test("entries without signatures are kept apart", () => {
  const untyped = normalizeDocumentSymbols([entry("f", "", 0, 9), entry("f", "", 1, 9)]);
  expect(declarationsNamed(untyped, "f").map((group) => group.length)).toEqual([1, 1]);
});

test("body detection uses a unique definition in the declaration group", () => {
  const body = (selector: string) =>
    bodyEntry(resolveSymbolDeclaration(symbols, selector.split("/"), "main.cpp"), text)
      ?.selectionRange.start.line;
  expect(body("clamp(int, int, int)")).toBe(10);
  expect(body("lerp")).toBe(16);
  expect(body("Box/get()")).toBe(5);
  const prototypes = resolveSymbolDeclaration(symbols, ["lerp"], "main.cpp");
  expect(bodyEntry(prototypes, text.replace("{ return a + (b - a) * t; }", ";"))).toBeUndefined();
});

// gopls names a method `(*Engine).Start` in its outline and `Engine.Start` in its workspace
// index; both ranges select the identifier `Start`.
const goLines = ["func (e *Engine) Start() {}", "func (o *Other) Start() {}", "func Start() {}"];
const goSymbols = normalizeDocumentSymbols(
  goLines.map((line, index) => {
    const name = ["(*Engine).Start", "(*Other).Start", "Start"][index] ?? "";
    const column = line.indexOf("Start");
    return {
      name,
      kind: index < 2 ? 6 : 12,
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: line.length },
      },
      selectionRange: {
        start: { line: index, character: column },
        end: { line: index, character: column + 5 },
      },
    };
  }),
);
const startAt = (line: number) => ({
  start: { line, character: goLines[line]?.indexOf("Start") ?? 0 },
  end: { line, character: (goLines[line]?.indexOf("Start") ?? 0) + 5 },
});
const declared = (
  groups: readonly (readonly { selectionRange: { start: { line: number } } }[] | undefined)[],
) => groups.map((group) => group?.map((entry) => entry.selectionRange.start.line));

test("a workspace symbol is found by the identifier at its range when the outline qualifies the name", () => {
  expect(
    declared(declarationsForWorkspaceSymbol(goSymbols, "Engine.Start", startAt(0), "Start")),
  ).toEqual([[0]]);
  expect(
    declared(declarationsForWorkspaceSymbol(goSymbols, "Other.Start", startAt(1), "Start")),
  ).toEqual([[1]]);
  expect(declared(declarationsForWorkspaceSymbol(goSymbols, "Start", startAt(2), "Start"))).toEqual(
    [[2]],
  );
});

test("a stale range finds only the outline declarations that carry the same qualified name", () => {
  expect(
    declared(declarationsForWorkspaceSymbol(goSymbols, "Engine.Start", startAt(2), "Start() {")),
  ).toEqual([[0]]);
  expect(declarationsForWorkspaceSymbol(goSymbols, "Gone.Start", startAt(0), "gone")).toEqual([]);
  expect(
    declared(declarationsForWorkspaceSymbol(goSymbols, "Engine.Start", startAt(2), undefined)),
  ).toEqual([[0]]);
});
