import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { createFileResolver } from "#src/resolvers.js";

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
