import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { TipStateStore } from "./persistence.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TipStateStore", () => {
  test("reads installation-wide claims without mixing them with project claims", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-global-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, global: ["setup-v1"], projects: { "/one": ["project-tip"] } }),
      "utf8",
    );
    const store = new TipStateStore(statePath);
    await expect(store.shownFor()).resolves.toEqual(new Set(["setup-v1"]));
    await expect(store.shownFor("/one")).resolves.toEqual(new Set(["project-tip"]));
    await expect(store.shownFor("/two")).resolves.toEqual(new Set());
  });

  test("claims a global revision once while preserving independent project tips", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-global-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    const first = new TipStateStore(statePath);
    const second = new TipStateStore(statePath);
    await first.markShown("/one", ["project-tip"]);
    const claims = await Promise.all([
      first.claimIfUnseen(undefined, "setup-v1"),
      second.claimIfUnseen(undefined, "setup-v1"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(first.claimIfUnseen(undefined, "setup-v1")).resolves.toBe(false);
    await expect(first.claimIfUnseen(undefined, "setup-v2")).resolves.toBe(true);
    await first.markShown("/two", ["other-project-tip"]);
    await expect(second.shownFor()).resolves.toEqual(new Set(["setup-v1", "setup-v2"]));
    await expect(second.shownFor("/one")).resolves.toEqual(new Set(["project-tip"]));
    await expect(second.shownFor("/two")).resolves.toEqual(new Set(["other-project-tip"]));
    await first.unmarkShown(undefined, "setup-v1");
    await expect(second.claimIfUnseen(undefined, "setup-v1")).resolves.toBe(true);
    await expect(second.shownFor("/one")).resolves.toEqual(new Set(["project-tip"]));
  });

  test("treats malformed global state as empty without blocking startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-global-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, global: [42], projects: { "/one": ["project-tip"] } }),
      "utf8",
    );
    const store = new TipStateStore(statePath);
    await expect(store.shownFor()).resolves.toEqual(new Set());
    await expect(store.shownFor("/one")).resolves.toEqual(new Set());
  });

  test("keeps global claims best effort when the state path is not a file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-global-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    await mkdir(statePath);
    const store = new TipStateStore(statePath);

    await expect(store.claimIfUnseen(undefined, "setup-v1")).resolves.toBe(true);
    await expect(store.markShown(undefined, ["setup-v1"])).resolves.toBeUndefined();
    await expect(store.unmarkShown(undefined, "setup-v1")).resolves.toBeUndefined();
    await expect(store.shownFor()).resolves.toEqual(new Set());
  });

  test("records shown tips per project and preserves other projects", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const store = new TipStateStore(path.join(directory, "tips.json"));

    await store.markShown("/one", ["tip-a"]);
    await store.markShown("/two", ["tip-b"]);

    await expect(store.shownFor("/one")).resolves.toEqual(new Set(["tip-a"]));
    await expect(store.shownFor("/two")).resolves.toEqual(new Set(["tip-b"]));
  });

  test("fails open for malformed state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    await writeFile(statePath, "not json", "utf8");

    await expect(new TipStateStore(statePath).shownFor("/project")).resolves.toEqual(new Set());
  });

  test("merges updates from independent stores", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    const first = new TipStateStore(statePath);
    const second = new TipStateStore(statePath);

    await Promise.all([
      first.markShown("/project", ["tip-a"]),
      second.markShown("/project", ["tip-b"]),
    ]);

    await expect(first.shownFor("/project")).resolves.toEqual(new Set(["tip-a", "tip-b"]));
  });

  test("allows only one concurrent store to claim a tip", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    const first = new TipStateStore(statePath);
    const second = new TipStateStore(statePath);

    const claims = await Promise.all([
      first.claimIfUnseen("/project", '["provider","tip"]'),
      second.claimIfUnseen("/project", '["provider","tip"]'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(first.shownFor("/project")).resolves.toEqual(new Set(['["provider","tip"]']));
  });

  test("allows a failed claim to be retried", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const store = new TipStateStore(path.join(directory, "tips.json"));

    await expect(store.claimIfUnseen("/project", "provider:tip")).resolves.toBe(true);
    await store.unmarkShown("/project", "provider:tip");

    await expect(store.claimIfUnseen("/project", "provider:tip")).resolves.toBe(true);
  });

  test("recovers an abandoned state lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-ide-tips-"));
    directories.push(directory);
    const statePath = path.join(directory, "tips.json");
    const lockPath = `${statePath}.lock`;
    await mkdir(lockPath);
    await utimes(lockPath, new Date(0), new Date(0));

    await new TipStateStore(statePath).markShown("/project", ["tip-a"]);

    await expect(new TipStateStore(statePath).shownFor("/project")).resolves.toEqual(
      new Set(["tip-a"]),
    );
  });
});
