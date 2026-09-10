import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { TempResourceStore } from "#src/core/tools/read/temp-resource-store.js";

const stores: TempResourceStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("keeps resources readable across long idle periods until disposal", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const source = await store.save("alpha\nbravo\ncharlie");

  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(await readTemporarySource(store, source)).toBe("alpha\nbravo\ncharlie");
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(await readTemporarySource(store, source)).toBe("alpha\nbravo\ncharlie");
});

test("isolates resources and removes only the disposed store's files", async () => {
  const { store: first, parentDirectory } = await createStore();
  const second = new TempResourceStore({ parentDirectory });
  stores.push(second);
  const source = await first.save("first");
  const other = await second.save("second");
  const resolved = await first.resolver.tryResolve(source, { cwd: "/workspace" });
  expect(resolved.kind).toBe("resolved");
  expect(await second.resolver.tryResolve(source, { cwd: "/workspace" })).toMatchObject({
    kind: "failed",
  });
  expect(await first.resolver.tryResolve("file.txt", { cwd: "/workspace" })).toEqual({
    kind: "not-handled",
  });
  expect(await readdir(parentDirectory)).toHaveLength(2);

  await first.dispose();
  expect(await readdir(parentDirectory)).toHaveLength(1);
  expect(await first.resolver.tryResolve(source, { cwd: "/workspace" })).toMatchObject({
    kind: "failed",
  });
  if (resolved.kind !== "resolved" || resolved.resource.read === undefined)
    throw new Error("Missing resource");
  await expect(resolved.resource.read({})).rejects.toBeInstanceOf(Error);
  await expect(first.save("closed")).rejects.toBeInstanceOf(Error);
  await first.dispose();
  expect(await readTemporarySource(second, other)).toBe("second");
  await second.dispose();
  expect(await readdir(parentDirectory)).toEqual([]);
});

test("finishes pending saves before disposal completes without retaining resources", async () => {
  const { store, parentDirectory } = await createStore();
  const saving = store.save("pending");
  await Promise.all([store.dispose(), store.dispose()]);
  const source = await saving;
  expect(await readdir(parentDirectory)).toEqual([]);
  expect(await store.resolver.tryResolve(source, { cwd: "/workspace" })).toMatchObject({
    kind: "failed",
  });
});

test("disposes an unused store without creating a directory", async () => {
  const { store, parentDirectory } = await createStore();
  await store.dispose();
  await expect(store.save("closed")).rejects.toBeInstanceOf(Error);
  expect(await readdir(parentDirectory)).toEqual([]);
});

async function createStore(): Promise<{ store: TempResourceStore; parentDirectory: string }> {
  const parentDirectory = await mkdtemp(path.join(tmpdir(), "pi-agent-read-temp-test-"));
  directories.push(parentDirectory);
  const store = new TempResourceStore({ parentDirectory });
  stores.push(store);
  return { store, parentDirectory };
}

async function readTemporarySource(store: TempResourceStore, source: string): Promise<string> {
  const attempt = await store.resolver.tryResolve(source, { cwd: "/workspace" });

  if (attempt.kind !== "resolved" || attempt.resource.read === undefined) {
    throw new Error(`Unable to resolve ${source}`);
  }

  const content = await attempt.resource.read({});
  const block = content[0];

  if (block.type !== "text") {
    throw new Error(`Temporary resource ${source} did not contain text`);
  }

  return block.text;
}
