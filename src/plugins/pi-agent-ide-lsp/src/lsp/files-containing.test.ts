import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  filesContainingArguments,
  filesContainingOutput,
  localFilesContaining,
} from "./files-containing.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("ripgrep looks for the whole word as fixed text in files with the given extensions", () => {
  const arguments_ = filesContainingArguments("a.b", [".cpp", ".h"]);
  expect(arguments_).toEqual(
    expect.arrayContaining(["--files-with-matches", "--fixed-strings", "--word-regexp"]),
  );
  expect(arguments_.slice(-4)).toEqual(["--regexp", "a.b", "--", "."]);
  expect(arguments_.join(" ")).toContain("--glob *.cpp --glob *.h");
});

test("ripgrep output becomes relative paths without the ./ prefix", () => {
  expect(filesContainingOutput("./a.cpp\r\n./src/b.h\n\n")).toEqual(["a.cpp", "src/b.h"]);
});

test("local files that contain the name as a whole word are listed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "files-containing-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.cpp"), "call_target(1);\n");
  writeFileSync(path.join(root, "b.cpp"), "call_target_more(1);\n");
  writeFileSync(path.join(root, "c.txt"), "call_target(1);\n");
  expect(await localFilesContaining(root, "call_target", [".cpp"])).toEqual([
    path.join(root, "src/a.cpp"),
  ]);
  expect(await localFilesContaining(root, "absent", [".cpp"])).toEqual([]);
});
