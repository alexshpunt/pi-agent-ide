import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { DEFAULT_RENDERER_CONFIG, loadRendererConfig, parseRendererConfig } from "#src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("defaults to the full diff view without a config file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "renderer-config-"));
  directories.push(directory);
  expect(loadRendererConfig(directory)).toEqual(DEFAULT_RENDERER_CONFIG);
});

test("keeps the full diff view by default and honors the compact override", () => {
  expect(parseRendererConfig(undefined)).toEqual({ diffView: "full" });
  expect(parseRendererConfig({ diffView: "compact" })).toEqual({ diffView: "compact" });
  expect(parseRendererConfig({})).toEqual({ diffView: "full" });
});

test("loads the compact override from text-editor.json", async () => {
  const directory = await project({
    recovery: { contextLines: 3 },
    renderer: { diffView: "compact" },
  });
  expect(loadRendererConfig(directory)).toEqual({ diffView: "compact" });
});

test("rejects invalid renderer settings", async () => {
  expect(() => parseRendererConfig({ diffView: "wide" })).toThrow(
    'renderer.diffView must be "full" or "compact"',
  );
  expect(() => parseRendererConfig({ unknown: true })).toThrow(
    "renderer contains unknown key unknown",
  );

  const directory = await project({ renderer: { diffView: true } });
  expect(() => loadRendererConfig(directory)).toThrow("must be");
});

async function project(config: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "renderer-config-"));
  directories.push(directory);
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "text-editor.json"), JSON.stringify(config));
  return directory;
}
