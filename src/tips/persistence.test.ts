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
