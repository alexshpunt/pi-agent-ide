import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { DEFAULT_EXACT_TEXT_RECOVERY_CONFIG, loadExactTextRecoveryConfig } from "#src/config.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

test("uses documented defaults when project config is absent", async () => {
  const directory = await workspace();
  expect(loadExactTextRecoveryConfig(directory)).toEqual(DEFAULT_EXACT_TEXT_RECOVERY_CONFIG);
});

test("merges a partial recovery config with defaults", async () => {
  const directory = await workspace({
    recovery: { timeoutMs: 500, exactText: { threshold: 0.9, fuzzyEnabled: false } },
  });
  expect(loadExactTextRecoveryConfig(directory)).toMatchObject({
    timeoutMs: 500,
    threshold: 0.9,
    fuzzyEnabled: false,
    exactCandidateLimit: 20,
  });
});

test("rejects unknown keys and unsafe limits", async () => {
  const unknown = await workspace({ recovery: { exactText: { surprise: true } } });
  expect(() => loadExactTextRecoveryConfig(unknown)).toThrow("unknown key surprise");

  const unsafe = await workspace({ recovery: { timeoutMs: 10_001 } });
  expect(() => loadExactTextRecoveryConfig(unsafe)).toThrow("timeoutMs must be between");
});

async function workspace(config?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "exact-anchor-config-"));
  directories.push(directory);
  if (config !== undefined) {
    const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, "text-editor.json"), JSON.stringify(config));
  }
  return directory;
}
