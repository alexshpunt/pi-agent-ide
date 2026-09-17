import { expect, test } from "vitest";

import { sameFilePath } from "./path-identity.js";

test("Windows debugger paths ignore drive and directory case", () => {
  expect(sameFilePath("C:\\Users\\Agent\\main.ts", "c:\\users\\agent\\main.ts", "win32")).toBe(
    true,
  );
});

test("POSIX debugger paths remain case-sensitive", () => {
  expect(sameFilePath("/work/Main.ts", "/work/main.ts", "linux")).toBe(false);
});
