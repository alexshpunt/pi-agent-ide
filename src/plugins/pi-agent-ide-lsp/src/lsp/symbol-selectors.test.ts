import { expect, test } from "vitest";

import {
  declarationBody,
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

test("an ambiguous or unknown selector lists usable selectors without percent encoding", () => {
  expect(() => lines(["clamp"])).toThrow(
    'Symbol selector "clamp" matches 2 declarations in main.cpp: main.cpp#clamp(int, int, int) (line 1, 11), main.cpp#clamp(const Vec&, float, float) (line 2, 14). Use one of these selectors.',
  );
  expect(() => lines(["clamp(float, float)"])).toThrow(
    'Symbol "clamp(float, float)" was not found in main.cpp. Declarations named "clamp": main.cpp#clamp(int, int, int) (line 1, 11), main.cpp#clamp(const Vec&, float, float) (line 2, 14).',
  );
  expect(() => lines(["missing"])).toThrow('Symbol "missing" was not found in main.cpp.');
});

test("servers without signatures keep each entry apart and say why a name stays ambiguous", () => {
  const untyped = normalizeDocumentSymbols([entry("f", "", 0, 9), entry("f", "", 1, 9)]);
  expect(() => resolveSymbolDeclaration(untyped, ["f"], "a.ts")).toThrow(
    "The language server reports no signatures that tell them apart.",
  );
  expect(() => resolveSymbolDeclaration(untyped, ["f(int)"], "a.ts")).toThrow("was not found");
});

test("a text edit takes the entry with a body, and fails when none or several have one", () => {
  const body = (selector: string) =>
    declarationBody(
      resolveSymbolDeclaration(symbols, selector.split("/"), "main.cpp"),
      text,
      "main.cpp",
    ).selectionRange.start.line + 1;
  expect(body("clamp(int, int, int)")).toBe(11);
  expect(body("lerp")).toBe(17);
  expect(body("Box/get()")).toBe(6);
  const prototypes = resolveSymbolDeclaration(symbols, ["lerp"], "main.cpp");
  expect(() =>
    declarationBody(
      prototypes,
      text.replace("{ return a + (b - a) * t; }", ";".padEnd(27)),
      "main.cpp",
    ),
  ).toThrow("main.cpp#lerp is declared 2 times (lines 3, 17)");
});
