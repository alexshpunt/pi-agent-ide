import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { URI } from "vscode-uri";
import { LspFileWatchers, type WatchedFileChange } from "./file-watchers.js";

test("delivers native matching file events and stops an unregistered subscription", async () => {
  const parent = path.resolve(".agents/tmp/lsp-watcher-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "project "));
  const changes: WatchedFileChange[] = [];
  const errors: Error[] = [];
  const watchers = new LspFileWatchers(
    root,
    (event) => changes.push(event),
    (error) => errors.push(error),
  );
  const file = path.join(root, "CMakeLists.txt");
  const uri = URI.file(file).toString();
  try {
    await watchers.register("cmake", [
      {
        globPattern: { baseUri: URI.file(root).toString(), pattern: "**/CMakeLists.txt" },
        kind: 5,
      },
    ]);
    await writeFile(path.join(root, "unrelated.txt"), "ignore");
    await writeFile(file, "project(Matrix)\n");
    await expect
      .poll(() => changes.some((event) => event.uri === uri && event.type === 1))
      .toBe(true);
    await writeFile(file, "project(Changed)\n");
    await rm(file);
    await expect
      .poll(() => changes.some((event) => event.uri === uri && event.type === 3))
      .toBe(true);
    expect(changes.every((event) => event.uri === uri && event.type !== 2)).toBe(true);
    watchers.unregister("cmake");
    const count = changes.length;
    await writeFile(file, "project(AfterUnregister)\n");
    await delay(100);
    expect(changes).toHaveLength(count);
    expect(errors).toEqual([]);
  } finally {
    watchers.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
