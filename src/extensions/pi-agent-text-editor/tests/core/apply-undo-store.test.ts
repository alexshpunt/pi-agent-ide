import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ApplyUndoStore } from "#src/core/apply/apply-undo-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "apply-undo-"));
  roots.push(root);
  const edited = path.join(root, "edited.bin");
  const created = path.join(root, "created.bin");
  const before = Buffer.from([0, 1, 2]);
  await writeFile(edited, before);
  return { root, edited, created, before };
}

test("restores every touched path once", async () => {
  const { edited, created, before } = await fixture();
  const store = new ApplyUndoStore();
  await writeFile(edited, Buffer.from([3, 4]));
  await writeFile(created, Buffer.from([5, 6]));
  const transaction = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);

  await expect(store.restore(transaction)).resolves.toMatchObject({ transaction });
  expect(await readFile(edited)).toEqual(before);
  await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.restore(transaction)).rejects.toMatchObject({
    code: "APPLY_UNDO_UNAVAILABLE",
  });
});

test("rejects the whole receipt when one path changed", async () => {
  const { edited, created, before } = await fixture();
  const store = new ApplyUndoStore();
  await writeFile(edited, "after");
  await writeFile(created, "created");
  const transaction = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);
  await writeFile(edited, "newer");

  await expect(store.restore(transaction)).rejects.toMatchObject({ code: "APPLY_UNDO_STALE" });
  expect(await readFile(edited, "utf8")).toBe("newer");
  expect(await readFile(created, "utf8")).toBe("created");
});

test("rolls back a partially failed undo", async () => {
  const { edited, created, before } = await fixture();
  let restoreCount = 0;
  const store = new ApplyUndoStore(async (state) => {
    restoreCount += 1;
    if (restoreCount === 2) throw new Error("injected restore failure");
    if (state.existed) await writeFile(state.path, state.bytes ?? new Uint8Array());
    else await rm(state.path, { force: true });
  });
  await writeFile(edited, "after");
  await writeFile(created, "created");
  const transaction = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);

  await expect(store.restore(transaction)).rejects.toMatchObject({
    code: "APPLY_UNDO_FAILED",
    rollbackErrors: [],
  });
  expect(await readFile(edited, "utf8")).toBe("after");
  expect(await readFile(created, "utf8")).toBe("created");
});

test("keeps a receipt valid across final formatter completion", async () => {
  const { edited, before } = await fixture();
  const store = new ApplyUndoStore();
  await writeFile(edited, "unformatted");
  const transaction = await store.record([{ path: edited, existed: true, bytes: before }]);
  store.observeTextChange(edited, "unformatted", "formatted\n", "final");
  await writeFile(edited, "formatted\n");

  await expect(store.restore(transaction)).resolves.toMatchObject({ transaction });
  expect(await readFile(edited)).toEqual(before);
});
