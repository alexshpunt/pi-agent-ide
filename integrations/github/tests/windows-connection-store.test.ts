import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GithubConnectionStore } from "#github/connections/store.ts";

const windows = process.platform === "win32";
const profile = { id: "personal", kind: "pat" as const, label: "Personal" };
const secret = { kind: "pat" as const, token: "fixture-token" };

it.skipIf(!windows)(
  "Windows stores and reopens a connection and its default",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-store-test-"));
    try {
      const store = new GithubConnectionStore(directory);
      await store.saveProfile(profile, secret);
      await store.setGlobalDefaultForNewSessions(profile.id);
      const reopened = new GithubConnectionStore(directory);
      expect(await reopened.listProfiles()).toEqual([profile]);
      expect(await reopened.getGlobalDefaultChoice()).toEqual({ id: profile.id, preferred: true });
      expect(
        await reopened.withSecret(profile.id, async (value) => ({ secret: value, value })),
      ).toEqual(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!windows)(
  "Windows refuses to read a credential granted to everyone",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-store-test-"));
    try {
      const store = new GithubConnectionStore(directory);
      await store.saveProfile(profile, secret);
      execFileSync("icacls.exe", [
        path.join(directory, "credentials.json"),
        "/grant",
        "*S-1-1-0:(R)",
      ]);
      await expect(store.listProfiles()).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!windows)(
  "Windows refuses to write in a directory granted to everyone",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-store-test-"));
    try {
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(R)"]);
      await expect(
        new GithubConnectionStore(directory).saveProfile(profile, secret),
      ).rejects.toBeInstanceOf(Error);
      await expect(stat(path.join(directory, "credentials.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

const pwsh7Modules = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "PowerShell",
  "7",
  "Modules",
);
it.skipIf(!windows || !existsSync(path.join(pwsh7Modules, "Microsoft.PowerShell.Security")))(
  "Windows protects connections when launched from PowerShell 7",
  async () => {
    const directory = await mkdtemp(path.join(homedir(), "github-store-module-test-"));
    try {
      const modules = [
        path.join(homedir(), "Documents", "PowerShell", "Modules"),
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "Modules"),
        pwsh7Modules,
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsPowerShell", "Modules"),
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "Modules",
        ),
      ].join(path.delimiter);
      const entry = import.meta.resolve("#github/connections/store.ts");
      const script = `
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { GithubConnectionStore } from ${JSON.stringify(entry)};
      const dir = process.argv[1];
      process.env.PSModulePath = process.argv[2];
      const store = new GithubConnectionStore(dir);
      await store.saveProfile({id:'test',kind:'pat',label:'Test'}, {kind:'pat',token:'fixture-token'});
      if ((await store.listProfiles())[0]?.id !== 'test') process.exit(2);
      execFileSync('icacls.exe', [join(dir, 'credentials.json'), '/grant', '*S-1-1-0:(R)']);
      let refused = false;
      try { await store.listProfiles(); } catch { refused = true; }
      if (!refused) process.exit(3);
    `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, path.join(directory, "store"), modules],
        {
          encoding: "utf8",
          timeout: 30000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);
