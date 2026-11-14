import { expect, test } from "vitest";
import { localSearchSource } from "./native-search-source.ts";

const issued = new Set(["RESULT#search"]);

test.each([
  "/work/note.txt",
  "note.txt",
  "C:\\work\\note.txt",
  "D:/work/note.txt",
  "\\\\host\\share\\note.txt",
])("Search recognizes the local path %s", (source) => {
  expect(localSearchSource("SEARCH#ABCD:1:line", [{ source }], issued)).toBe(source);
  expect(localSearchSource("RESULT#search", [{ source }], issued)).toBe(source);
});

test.each([
  "ssh://host/work/note.txt",
  "memory://note",
  "shell:task",
  "debug:task",
  "fixture:note",
  "file:///work/note.txt",
])("Search leaves owned sources outside native batches: %s", (source) =>
  expect(localSearchSource("RESULT#search", [{ source }], issued)).toBeUndefined(),
);

test("only issued Search selections of exactly one file can join", () => {
  expect(localSearchSource("RESULT#pending", [{ source: "note.txt" }], issued)).toBeUndefined();
  expect(localSearchSource("RESULT#read", [{ source: "note.txt" }], issued)).toBeUndefined();
  expect(localSearchSource("SEARCH#ABCD:all:line", [], issued)).toBeUndefined();
  expect(
    localSearchSource("SEARCH#ABCD:all:line", [{ source: "a" }, { source: "b" }], issued),
  ).toBeUndefined();
});
