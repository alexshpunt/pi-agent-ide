import { githubPackageRoot } from "./fixtures/package-root.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGithubConfig } from "#github/config.ts";

let directory: string;
beforeEach(async () => {
  await mkdir(path.join(githubPackageRoot, ".tmp"), { recursive: true });
  directory = await mkdtemp(path.join(githubPackageRoot, ".tmp/config-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PI_CLANKER_CONFIG", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const settings = { appId: 123, installationId: 456, privateKeyPath: "/private/app.pem" };

describe("existing PiClanker App configuration", () => {
  it("uses the existing global configuration without a project credential file", async () => {
    delete process.env.PI_CLANKER_CONFIG;
    const folder = path.join(directory, ".config/pi-clanker");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "config.json"), JSON.stringify(settings), { mode: 0o600 });
    expect(await loadGithubConfig(directory)).toEqual(settings);
  });

  it("honors an explicit configuration path, including paths relative to cwd", async () => {
    const file = path.join(directory, "custom.json");
    await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
    vi.stubEnv("PI_CLANKER_CONFIG", file);
    expect(await loadGithubConfig("/another/project")).toEqual(settings);
    vi.stubEnv("PI_CLANKER_CONFIG", "custom.json");
    expect(await loadGithubConfig(directory)).toEqual(settings);
  });

  it("rejects invalid IDs, embedded keys and relative key paths without echoing content", async () => {
    const file = path.join(directory, "config.json");
    vi.stubEnv("PI_CLANKER_CONFIG", file);
    for (const invalid of [
      { ...settings, appId: 0 },
      { ...settings, installationId: 1.5 },
      { ...settings, privateKeyPath: "app.pem" },
      { appId: 123, installationId: 456, privateKey: "secret-PEM" },
      null,
    ]) {
      await writeFile(file, JSON.stringify(invalid), { mode: 0o600 });
      const error = await loadGithubConfig(directory).catch((value: unknown) => value);
      if (!(error instanceof Error)) throw new Error("Expected invalid App configuration to fail");
      expect(error.toString()).not.toContain("secret-PEM");
    }
  });

  it("does not expose broken config content or switch to another credential source", async () => {
    const file = path.join(directory, "bad.json");
    vi.stubEnv("PI_CLANKER_CONFIG", file);
    await writeFile(file, '{ "privateKey": "secret-config"', { mode: 0o600 });
    const error = await loadGithubConfig(directory).catch((value: unknown) => value);
    if (!(error instanceof Error)) throw new Error("Expected invalid App configuration to fail");
    expect(error.toString()).not.toContain("secret-config");
    vi.stubEnv("PI_CLANKER_CONFIG", "missing.json");
    await expect(loadGithubConfig(directory)).rejects.toThrow("configuration");
  });
});
