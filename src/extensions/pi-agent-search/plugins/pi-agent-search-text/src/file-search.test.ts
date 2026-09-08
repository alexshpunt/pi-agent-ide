import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { searchFiles } from "./file-search.js";

test("file globs find an existing file below an ignored parent directory", async () => {
  const root = path.resolve(".agents/tmp/file-search");
  await mkdir(root, { recursive: true });
  const parent = await mkdtemp(path.join(root, "case-"));
  const cwd = path.join(parent, "results/workspace");
  try {
    await mkdir(path.join(parent, ".git"));
    await writeFile(path.join(parent, ".gitignore"), "results/\n");
    await mkdir(path.join(cwd, "cases"), { recursive: true });
    await writeFile(path.join(cwd, "cases/part-001.test.ts"), "legacy\u200bCheckout\n");

    await writeFile(path.join(cwd, ".ignore"), "cases/ignored.test.ts\n");
    await writeFile(path.join(cwd, "cases/ignored.test.ts"), "ignored\n");
    for (const query of ["cases/*.test.ts", "**/cases/*.test.ts", "*.test.ts"]) {
      const result = await searchFiles(query, { query: `files:${query}`, path: "." }, cwd);
      expect(result.files).toEqual(["cases/part-001.test.ts"]);
      expect(result.complete).toBe(true);
    }
    expect((await searchFiles("csprt", { query: "files:csprt", path: "." }, cwd)).files).toEqual([
      "cases/part-001.test.ts",
    ]);
    expect(
      (
        await searchFiles(
          "*.test.ts",
          { query: "files:*.test.ts", path: ".", exclude: "part-*" },
          cwd,
        )
      ).files,
    ).toEqual([]);
    expect(
      (
        await searchFiles(
          "./cases/part-???.{test,spec}.ts",
          { query: "files:pattern", path: ".", limit: 1 },
          cwd,
        )
      ).files,
    ).toEqual(["cases/part-001.test.ts"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
