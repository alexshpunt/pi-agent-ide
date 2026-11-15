import { expect, test } from "vitest";
import { localSnapshotSource } from "./native-snapshot-source.ts";

const issued = new Set(["RESULT#search", "RESULT#read"]);

test.each([
  "/work/note.txt",
  "note.txt",
  "C:\\work\\note.txt",
  "D:/work/note.txt",
  "\\\\host\\share\\note.txt",
])("Search recognizes the local path %s", (source) => {
  expect(localSnapshotSource("SEARCH#ABCD:1:line", [{ source }], issued)).toBe(source);
  expect(localSnapshotSource("RESULT#search", [{ source }], issued)).toBe(source);
});

test.each([
  "ssh://host/work/note.txt",
  "memory://note",
  "shell:task",
  "debug:task",
  "fixture:note",
  "file:///work/note.txt",
])("Search leaves owned sources outside native batches: %s", (source) =>
  expect(localSnapshotSource("RESULT#search", [{ source }], issued)).toBeUndefined(),
);

test("only issued Read/Search selections of exactly one file can join", () => {
  expect(localSnapshotSource("RESULT#pending", [{ source: "note.txt" }], issued)).toBeUndefined();
  expect(localSnapshotSource("RESULT#read", [{ source: "note.txt" }], issued)).toBe("note.txt");
  expect(localSnapshotSource("SEARCH#ABCD:all:line", [], issued)).toBeUndefined();
  expect(
    localSnapshotSource("SEARCH#ABCD:all:line", [{ source: "a" }, { source: "b" }], issued),
  ).toBeUndefined();
});
