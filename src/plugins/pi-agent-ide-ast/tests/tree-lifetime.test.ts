import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as WTS from "web-tree-sitter";

import { AstScopeManager } from "#src/api/scope.ts";
import { AstOutlineManager } from "#src/ast/outline.ts";

// web-tree-sitter trees live in WASM memory that JavaScript GC never frees.
// Every tree the IDE parses must be deleted, or each parse of a large file leaks for the session.
const source = [
  "namespace demo {",
  "int add(int left, int right) {",
  "  if (left > right) {",
  "    return left + right;",
  "  }",
  "  return right;",
  "}",
  "}",
];

let created: WTS.Tree[];
let deleted: Set<WTS.Tree>;

beforeEach(() => {
  created = [];
  deleted = new Set();
  const parse = WTS.Parser.prototype.parse;
  vi.spyOn(WTS.Parser.prototype, "parse").mockImplementation(function (
    this: WTS.Parser,
    ...args: Parameters<WTS.Parser["parse"]>
  ) {
    const tree = parse.apply(this, args);
    if (tree) created.push(tree);
    return tree;
  });
  const remove = WTS.Tree.prototype.delete;
  vi.spyOn(WTS.Tree.prototype, "delete").mockImplementation(function (this: WTS.Tree) {
    deleted.add(this);
    remove.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function liveTrees(): number {
  return created.filter((tree) => !deleted.has(tree)).length;
}

test("scope discovery frees every syntax tree it parses", async () => {
  const scopes = await new AstScopeManager().getDocumentScopes("demo.cpp", "/workspace", source);

  expect(scopes.length).toBeGreaterThan(0);
  expect(created.length).toBeGreaterThan(0);
  expect(liveTrees()).toBe(0);
});

test("document outlines free every syntax tree they parse", async () => {
  const outline = await new AstOutlineManager().readDocumentOutline(
    "demo.cpp",
    "/workspace",
    source,
  );

  expect(outline).toBeDefined();
  expect(created.length).toBeGreaterThan(0);
  expect(liveTrees()).toBe(0);
});

test("symbol lookup frees the syntax trees of every file it checks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ast-tree-lifetime-"));
  try {
    await writeFile(path.join(directory, "a.cpp"), "int unrelated() { return 0; }\n");
    await writeFile(path.join(directory, "b.cpp"), `${source.join("\n")}\n`);

    await new AstOutlineManager().formatSymbol("add", directory);

    expect(created.length).toBeGreaterThan(1);
    expect(liveTrees()).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
