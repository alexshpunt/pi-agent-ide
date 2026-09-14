import { describe, expect, it } from "vitest";

import { parseDocument } from "./manager.js";
import { AstScopeManager } from "./manager.js";
import { isSupportedOutlinePath } from "./outline.js";

const languageSamples: Readonly<Record<string, string>> = {
  "sample.sh": "echo hello",
  "sample.cs": "class Greeter {}",
  "sample.css": "main { color: red; }",
  "sample.dart": "void main() {}",
  "sample.ex": "defmodule Greeter do\nend",
  "sample.go": "package main\nfunc main() {}",
  "sample.html": "<main>Hello</main>",
  "sample.java": "class Greeter {}",
  "sample.kt": "fun main() {}",
  "sample.lua": "function greet() end",
  "sample.md": "# Hello",
  "sample.php": "<?php function greet() {}",
  "sample.rb": "def greet\nend",
  "sample.scala": "object Main {}",
  "sample.sql": "SELECT name FROM people;",
  "sample.swift": "func greet() {}",
};

describe("native AST language parity", () => {
  it.each(Object.entries(languageSamples))("parses %s", async (filePath, source) => {
    expect(isSupportedOutlinePath(filePath)).toBe(true);
    const tree = await parseDocument(filePath, "/workspace", source.split("\n"));
    expect(tree?.rootNode.namedChildren.length).toBeGreaterThan(0);
  });

  it("creates scope anchors from a native parser", async () => {
    const lines = [
      "package main",
      "func greet() {",
      "  if true {",
      '    println("hello")',
      "  }",
      "}",
    ];
    const scopes = await new AstScopeManager().getDocumentScopes("sample.go", "/workspace", lines);

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes[0]?.scopeBeginAnchor.value).toMatch(/^scope-begin-/u);
    expect(scopes[0]?.scopeEndAnchor.value).toMatch(/^scope-end-/u);
  });
});
