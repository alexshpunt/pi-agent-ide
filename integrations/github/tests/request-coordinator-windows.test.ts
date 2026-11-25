import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

const windows = process.platform === "win32";
const url = "https://api.github.com/repos/fixture/repo";

test.skipIf(!windows)(
  "Windows persists and reloads rate limits while rejecting a shared state file",
  async () => {
    const directory = await mkdtemp(join(homedir(), "github-windows-rate-"));
    try {
      const gate = new GithubRequestCoordinator({ directory });
      const limited = vi.fn(
        async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
      );
      await gate.fetch("user:fixture", url, {}, { fetcher: limited });
      const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(1);
      const reopened = new GithubRequestCoordinator({ directory });
      await expect(reopened.check("user:fixture", url)).rejects.toMatchObject({
        code: "GH_RATE_LIMITED",
      });
      const [filename] = files;
      if (!filename) throw new Error("Expected a state file");
      execFileSync("icacls.exe", [join(directory, filename), "/grant", "*S-1-1-0:(R)"]);
      const send = vi.fn(async () => new Response("{}"));
      await expect(
        reopened.fetch("user:fixture", url, {}, { fetcher: send }),
      ).rejects.toMatchObject({ code: "GH_RATE_STATE_UNSAFE", effect: "not-applied" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!windows)(
  "Windows refuses to send HTTP when the rate directory is shared",
  async () => {
    const directory = await mkdtemp(join(homedir(), "github-windows-rate-unsafe-"));
    try {
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(R)"]);
      const gate = new GithubRequestCoordinator({ directory });
      const send = vi.fn(async () => new Response("{}"));
      await expect(gate.fetch("user:fixture", url, {}, { fetcher: send })).rejects.toMatchObject({
        code: "GH_RATE_STATE_UNSAFE",
        effect: "not-applied",
      });
      expect(send).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
