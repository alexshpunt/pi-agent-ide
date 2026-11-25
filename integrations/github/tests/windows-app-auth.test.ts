import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { GithubAppAuth } from "#github/auth.ts";
import { loadGithubConfig } from "#github/config.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";

const windows = process.platform === "win32";

it.skipIf(!windows)(
  "uses a private Windows App key and refuses a key readable by everyone",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-app-key-test-"));
    const file = path.join(directory, "app.pem");
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const fetcher = vi.fn(async () =>
      Response.json({ token: "fixture-token", expires_at: "2099-01-01T00:00:00Z" }),
    ) as typeof fetch;
    try {
      await writeFile(file, key);
      const config = { appId: 123, installationId: 456, privateKeyPath: file };
      expect(
        (
          await new GithubAppAuth(config, {
            coordinator: isolatedCoordinator(),
            fetcher,
          }).getToken()
        ).token,
      ).toBe("fixture-token");
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"]);
      await expect(
        new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
      ).rejects.toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!windows)(
  "reads a private Windows App configuration and refuses an unsafe ACL",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-app-config-test-"));
    const file = path.join(directory, "config.json");
    const config = {
      appId: 123,
      installationId: 456,
      privateKeyPath: path.join(directory, "app.pem"),
    };
    try {
      await writeFile(file, JSON.stringify(config));
      vi.stubEnv("PI_CLANKER_CONFIG", file);
      expect(await loadGithubConfig(directory)).toEqual(config);
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(W)"]);
      await expect(loadGithubConfig(directory)).rejects.toBeInstanceOf(Error);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
