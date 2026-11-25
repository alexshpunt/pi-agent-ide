import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubConnectionStore } from "#github/connections/store.ts";
import { GithubConnections } from "#github/connections/manager.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function store() {
  const directory = await mkdtemp(path.join(tmpdir(), "github-connection-migration-"));
  directories.push(directory);
  return new GithubConnectionStore(directory);
}
describe("connection removal and legacy compatibility", () => {
  it("does not recreate a disconnected legacy App when the project is reopened", async () => {
    const storage = await store();
    const config = { appId: 123, installationId: 456, privateKeyPath: "/not-opened.pem" };
    const first = new GithubConnections({ store: storage, legacyConfig: async () => config });
    const imported = await first.capture("/legacy-project");
    first.dispose();
    await storage.removeProfile(imported.profile.id);
    const reopened = new GithubConnections({ store: storage, legacyConfig: async () => config });
    await expect(
      reopened.capture("/legacy-project").then((access) => access.profile.id),
    ).rejects.toThrow("GH_CONNECTION_REQUIRED");
    expect(await storage.listProfiles()).toEqual([]);
    reopened.dispose();
  });

  it("cannot revive an inaccessible orphan secret as a new profile without credentials", async () => {
    const storage = await store();
    const profile = { id: "removed", label: "Removed", kind: "pat" as const };
    await storage.saveProfile(profile, { kind: "pat", token: "original-canary" });
    await storage.removeProfile(profile.id);
    await writeFile(
      path.join(storage.directory, "credentials.json"),
      JSON.stringify({ version: 1, secrets: { removed: { kind: "pat", token: "orphan-canary" } } }),
      { mode: 0o600 },
    );
    await expect(storage.saveProfile(profile)).rejects.toThrow("GH_CONNECTION_SECRET_REQUIRED");
    expect(await storage.listProfiles()).toEqual([]);
  });
});
