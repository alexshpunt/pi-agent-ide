import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubConnectionStore } from "#github/connections/store.ts";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("conditional connection removal", () => {
  it("preserves replacement even when a credential is changed back (ABA)", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "github-removal-"));
    const first = new GithubConnectionStore(directory);
    const other = new GithubConnectionStore(directory);
    const profile = { id: "a", label: "A", kind: "pat" } as const;
    await first.saveProfile(profile, { kind: "pat", token: "fixture-original" });
    const snapshot = await first.snapshotRemoval("a");
    if (!snapshot) throw new Error("Expected removal snapshot");
    expect(snapshot.profile).toEqual(profile);
    expect(JSON.stringify(snapshot)).not.toContain("fixture-original");
    await other.saveProfile(profile, { kind: "pat", token: "fixture-replacement" });
    await other.saveProfile(profile, { kind: "pat", token: "fixture-original" });
    expect(await first.removeProfileIfUnchanged("a", snapshot.epoch)).toBe(false);
    expect(await first.getProfile("a")).toEqual(profile);
  });

  it("detects an atomic profile rewrite by an older client", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "github-removal-"));
    const store = new GithubConnectionStore(directory);
    await store.saveProfile(
      { id: "a", label: "A", kind: "pat" },
      { kind: "pat", token: "fixture" },
    );
    const snapshot = await store.snapshotRemoval("a");
    if (!snapshot) throw new Error("Expected removal snapshot");
    const { readFile, writeFile, rename } = await import("node:fs/promises");
    const metadata = await readFile(path.join(directory, "profiles.json"));
    await writeFile(path.join(directory, "old-client.tmp"), metadata, { mode: 0o600 });
    await rename(path.join(directory, "old-client.tmp"), path.join(directory, "profiles.json"));
    expect(await store.removeProfileIfUnchanged("a", snapshot.epoch)).toBe(false);
    expect(await store.getProfile("a")).toBeDefined();
  });
  it("protects rotated credentials and removes an unchanged selected profile only", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "github-removal-"));
    const first = new GithubConnectionStore(directory);
    const other = new GithubConnectionStore(directory);
    const a = { id: "a", label: "A", kind: "device", clientId: "client" } as const;
    const b = { id: "b", label: "B", kind: "pat" } as const;
    await first.saveProfile(a, { kind: "device", accessToken: "access-a" });
    await first.saveProfile(b, { kind: "pat", token: "token-b" });
    const before = await first.snapshotRemoval("a");
    if (!before) throw new Error("Expected removal snapshot");
    await other.withSecret("a", async () => ({
      secret: { kind: "device", accessToken: "access-b" },
      value: undefined,
    }));
    expect(await first.removeProfileIfUnchanged("a", before.epoch)).toBe(false);
    const current = await first.snapshotRemoval("a");
    if (!current) throw new Error("Expected removal snapshot");
    expect(await first.removeProfileIfUnchanged("a", current.epoch)).toBe(true);
    expect(await first.getProfile("a")).toBeUndefined();
    expect(await first.getProfile("b")).toEqual(b);
  });
});
