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
      const result = await searchFiles(query, { query, path: "." }, cwd);
      expect(result.files).toEqual(["cases/part-001.test.ts"]);
      expect(result.complete).toBe(true);
    }
    expect((await searchFiles("csprt", { query: "csprt", path: "." }, cwd)).files).toEqual([
      "cases/part-001.test.ts",
    ]);
    expect(
      (await searchFiles("*.test.ts", { query: "*.test.ts", path: ".", exclude: "part-*" }, cwd))
        .files,
    ).toEqual([]);
    expect(
      (
        await searchFiles(
          "./cases/part-???.{test,spec}.ts",
          { query: "pattern", path: ".", limit: 1 },
          cwd,
        )
      ).files,
    ).toEqual(["cases/part-001.test.ts"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("include and exclude globs keep comma-separated brace alternatives", async () => {
  const root = path.resolve(".agents/tmp/file-search");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "braces-"));
  try {
    await mkdir(path.join(cwd, "stage"), { recursive: true });
    for (const file of ["CMakeLists.txt", "build.cmake", "api.h", "api.cpp"])
      await writeFile(path.join(cwd, "stage", file), "");
    const include = await searchFiles(
      "*",
      { query: "*", path: ".", include: "**/*.{cmake,txt,h}" },
      cwd,
    );
    expect(include.files.toSorted()).toEqual([
      "stage/CMakeLists.txt",
      "stage/api.h",
      "stage/build.cmake",
    ]);
    const exclude = await searchFiles(
      "*",
      { query: "*", path: ".", exclude: "*.{cmake,h}, *.txt" },
      cwd,
    );
    expect(exclude.files).toEqual(["stage/api.cpp"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a limited search returns the first matches in sort order and reports the rest", async () => {
  const root = path.resolve(".agents/tmp/file-search");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "limit-"));
  try {
    const names = Array.from(
      { length: 40 },
      (_, index) => `file-${String(index).padStart(2, "0")}.ts`,
    );
    await Promise.all(names.map((name) => writeFile(path.join(cwd, name), "")));
    await writeFile(path.join(cwd, "other.md"), "");
    const limited = await searchFiles("*.ts", { query: "*.ts", path: ".", limit: 5 }, cwd);
    expect(limited).toEqual({ files: names.slice(0, 5), complete: false });
    const all = await searchFiles("*.ts", { query: "*.ts", path: ".", limit: 40 }, cwd);
    expect(all).toEqual({ files: names, complete: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
