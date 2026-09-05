import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { loadTextEditorConfig, recoverySection } from "#src/core/text-editor-config.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

test("loads generic recovery limits and leaves plugin settings opaque", async () => {
  const directory = await project({
    recovery: { contextLines: 3, timeoutMs: 400, exactText: { threshold: 0.9 } },
  });
  expect(recoverySection(loadTextEditorConfig(directory), "exactText")).toEqual({
    contextLines: 3,
    timeoutMs: 400,
    settings: { threshold: 0.9 },
  });
});

test("leaves a disabled plugin section untouched", async () => {
  const directory = await project({ recovery: { exactText: { future: true } } });
  expect(loadTextEditorConfig(directory)).toBeDefined();
});

test("accepts the renderer section next to recovery", async () => {
  const directory = await project({
    recovery: { contextLines: 2 },
    renderer: { diffView: "compact" },
  });
  expect(recoverySection(loadTextEditorConfig(directory), "exactText").contextLines).toBe(2);
});

async function project(config: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "text-editor-config-"));
  directories.push(directory);
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "text-editor.json"), JSON.stringify(config));
  return directory;
}
