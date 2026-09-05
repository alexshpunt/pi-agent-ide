import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, expect, test } from "vitest";

import { loadSearchConfig, resolveSearchConfigPaths } from "#src/core/search-config.js";

const tempRoot = path.resolve(".agents", "tmp", "search-config-tests");
await mkdir(tempRoot, { recursive: true });

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("uses a 30 second timeout when search config is missing", async () => {
  const root = await mkdtemp(path.join(tempRoot, "default-"));
  const paths = resolveSearchConfigPaths({}, path.join(root, "home"), path.join(root, "project"));

  await expect(loadSearchConfig(paths)).resolves.toEqual({ timeoutMs: 30_000 });
});

test("lets global search config disable the timeout", async () => {
  const root = await mkdtemp(path.join(tempRoot, "global-"));
  const paths = resolveSearchConfigPaths(
    { PI_CODING_AGENT_DIR: path.join(root, "agent") },
    path.join(root, "home"),
    path.join(root, "project"),
  );
  await mkdir(path.dirname(paths.globalPath), { recursive: true });
  await writeFile(paths.globalPath, JSON.stringify({ timeoutMs: null }), "utf8");

  await expect(loadSearchConfig(paths)).resolves.toEqual({ timeoutMs: null });
});

test("lets project search config override global config and disable the timeout", async () => {
  const root = await mkdtemp(path.join(tempRoot, "layered-"));
  const paths = resolveSearchConfigPaths(
    { PI_CODING_AGENT_DIR: path.join(root, "agent") },
    path.join(root, "home"),
    path.join(root, "project"),
  );
  await Promise.all([
    mkdir(path.dirname(paths.globalPath), { recursive: true }),
    mkdir(path.dirname(paths.projectPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.globalPath, JSON.stringify({ timeoutMs: 5000 }), "utf8"),
    writeFile(paths.projectPath, JSON.stringify({ timeoutMs: null }), "utf8"),
  ]);

  await expect(loadSearchConfig(paths)).resolves.toEqual({ timeoutMs: null });
});

test.each([
  [{ timeoutMs: 0 }, "timeoutMs must be a positive integer or null"],
  [{ timeoutMs: 1.5 }, "timeoutMs must be a positive integer or null"],
  [{ timeoutMs: "30" }, "timeoutMs must be a positive integer or null"],
  [{ timeoutMs: 30_000, extra: true }, "contains unknown key extra"],
] as const)("rejects invalid search config %j", async (config, message) => {
  const root = await mkdtemp(path.join(tempRoot, "invalid-"));
  const paths = resolveSearchConfigPaths({}, path.join(root, "home"), path.join(root, "project"));
  await mkdir(path.dirname(paths.projectPath), { recursive: true });
  await writeFile(paths.projectPath, JSON.stringify(config), "utf8");

  await expect(loadSearchConfig(paths)).rejects.toThrow(message);
});
