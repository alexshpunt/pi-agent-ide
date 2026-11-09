import { expect, test } from "vitest";

import { localObjectMode } from "#src/api/native-files.ts";

const entry = (mode: number, directory = false) => ({ mode, isDirectory: () => directory });

test("Windows objects copied to a POSIX target get usable, non-world-writable modes", () => {
  // Node reports these modes for a writable directory, a writable file and a read-only file.
  expect(localObjectMode(entry(0o40666, true), "win32")).toBe(0o40755);
  expect(localObjectMode(entry(0o100666), "win32")).toBe(0o100644);
  expect(localObjectMode(entry(0o100444), "win32")).toBe(0o100444);
});

test("POSIX objects keep their own modes", () => {
  expect(localObjectMode(entry(0o40700, true), "linux")).toBe(0o40700);
  expect(localObjectMode(entry(0o100755), "linux")).toBe(0o100755);
});
