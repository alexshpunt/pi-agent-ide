import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { createFileResolver } from "#src/resolvers.ts";

async function workspace(): Promise<string> {
  const base = path.resolve(".tmp/file-resolver-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src/nested"), { recursive: true });
  await writeFile(path.join(cwd, "src/nested/task-one.txt"), "a\n");
  await writeFile(path.join(cwd, "src/notes.md"), "b\n");
  return cwd;
}

test("file_search options select the file resolver and return matching paths", async () => {
  const cwd = await workspace();
  const resolver = createFileResolver();

  const result = await resolver.tryResolve(
    { query: "*.txt", path: "src", options: { files: { pattern: "*.txt" } } },
    { cwd },
  );

  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") return;
  expect(resolver.toScriptData?.(result.payload, {})).toEqual({
    kind: "files",
    files: ["src/nested/task-one.txt"],
    complete: true,
  });
});

test("a files: query without file_search options is not a path search", async () => {
  const cwd = await workspace();

  await expect(
    createFileResolver().tryResolve({ query: "files:*.txt", path: "src" }, { cwd }),
  ).resolves.toEqual({ kind: "not-handled" });
});

test("an uncapped search lists every file unless the request sets a limit", async () => {
  const cwd = await workspace();
  const names = Array.from({ length: 105 }, (_, index) => `many/file-${String(index)}.log`);
  await mkdir(path.join(cwd, "many"));
  await Promise.all(names.map((name) => writeFile(path.join(cwd, name), "")));
  const resolver = createFileResolver();
  const files = async (request: { limit?: number }, uncapped?: boolean) => {
    const result = await resolver.tryResolve(
      {
        query: "*.log",
        ...request,
        options: { files: { pattern: "*.log", ...(uncapped === undefined ? {} : { uncapped }) } },
      },
      { cwd },
    );
    if (result.kind !== "resolved") throw new Error("file search was not resolved");
    return resolver.toScriptData?.(result.payload, {}) as { files: string[]; complete: boolean };
  };

  const all = await files({}, true);
  expect(all.files).toHaveLength(105);
  expect(all.complete).toBe(true);
  const limited = await files({ limit: 2 }, true);
  expect(limited.files).toHaveLength(2);
  expect(limited.complete).toBe(false);
  const capped = await files({});
  expect(capped.files).toHaveLength(100);
  expect(capped.complete).toBe(false);
});
