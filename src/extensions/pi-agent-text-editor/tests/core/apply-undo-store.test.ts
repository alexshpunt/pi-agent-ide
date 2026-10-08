import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ApplyUndoStore } from "#src/core/apply/apply-undo-store.js";
import type { ApplyFileState } from "#src/api/apply-files.js";
import { captureLocalFileState, restoreLocalFileState } from "#src/core/apply/local-journal.js";

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

test("reloaded undo rejects a rebound owner before contacting the retained backend", async () => {
  const source = "ssh://sandbox/tmp/note.txt";
  let bytes = Buffer.from("after");
  let captures = 0;
  const before = { path: source, existed: true, bytes: Buffer.from("before") };
  const access = {
    ownerKey: () => "sandbox:original-host",
    async capture() {
      captures += 1;
      return { path: source, existed: true, bytes };
    },
    async restore(state: ApplyFileState) {
      bytes = Buffer.from(state.bytes ?? []);
    },
  };
  const store = new ApplyUndoStore();
  const receipt = await store.record([before], access);
  const initialCaptures = captures;
  await expect(store.restore(receipt, undefined, () => "sandbox:other-host")).rejects.toMatchObject(
    {
      code: "APPLY_UNDO_OWNER_CHANGED",
    },
  );
  expect(captures).toBe(initialCaptures);
  expect(bytes.toString()).toBe("after");
  expect(store.has(receipt)).toBe(true);
  await store.restore(receipt, undefined, access.ownerKey);
  expect(bytes.toString()).toBe("before");
});
test("undo checks disk-backed fingerprints and releases captured backups", async () => {
  const source = "ssh://sandbox/tmp/large.bin";
  let digest = "b".repeat(64);
  let released = 0;
  const before = {
    path: source,
    existed: true,
    backup: {
      sha256: "a".repeat(64),
      async release() {
        released += 1;
      },
    },
  };
  const access = {
    async capture() {
      return {
        path: source,
        existed: true,
        backup: {
          sha256: digest,
          async release() {
            released += 1;
          },
        },
      };
    },
    async restore() {
      throw new Error("Stale backup must not be restored");
    },
  };
  const store = new ApplyUndoStore();
  const receipt = await store.record([before], access);
  expect(released).toBe(1);
  digest = "c".repeat(64);
  await expect(store.restore(receipt)).rejects.toMatchObject({ code: "APPLY_UNDO_STALE" });
  expect(released).toBe(3);
  expect(store.has(receipt)).toBe(false);
});

test("session shutdown waits for invalidated backup cleanup", async () => {
  let released = 0;
  const source = "ssh://sandbox/tmp/owned.bin";
  const backup = {
    sha256: "a".repeat(64),
    async release() {
      released += 1;
    },
  };
  const store = new ApplyUndoStore();
  const receipt = await store.record([{ path: source, existed: true, backup }], {
    async capture() {
      return { path: source, existed: false };
    },
    async restore() {
      throw new Error("Unexpected restore");
    },
  });
  store.observeTextChange(source, "before", "after", "complete");
  expect(store.has(receipt)).toBe(false);
  await store.dispose();
  expect(released).toBe(1);
});

test("uses the resource owner for URI undo and rejects newer remote bytes", async () => {
  const source = "ssh://sandbox/tmp/note.bin";
  const files = new Map<string, Uint8Array>([[source, Uint8Array.from([0, 255, 3])]]);
  const store = new ApplyUndoStore(
    async (state) => {
      if (state.existed) files.set(state.path, state.bytes ?? new Uint8Array());
      else files.delete(state.path);
    },
    async (file) => {
      const bytes = files.get(file);
      return { path: file, existed: bytes !== undefined, ...(bytes && { bytes: bytes.slice() }) };
    },
  );
  const before = Uint8Array.from([0, 254, 2]);
  const transaction = await store.record([{ path: source, existed: true, bytes: before }]);
  expect(await store.restore(transaction)).toEqual({
    transaction,
    restored: [source],
    restoredStates: [{ source, state: "present" }],
  });
  expect(files.get(source)).toEqual(before);
  files.set(source, Uint8Array.from([4]));
  const stale = await store.record([{ path: source, existed: true, bytes: before }]);
  files.set(source, Uint8Array.from([5]));
  await expect(store.restore(stale)).rejects.toMatchObject({ code: "APPLY_UNDO_STALE" });
  expect(files.get(source)).toEqual(Uint8Array.from([5]));
});

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

test("undo compensation keeps an external edit after a refused restore", async () => {
  const { edited, created, before } = await fixture();
  await writeFile(edited, "after");
  await writeFile(created, "created");
  let refused = false;
  const store = new ApplyUndoStore(async (state) => {
    if (state.path === created && !refused) {
      refused = true;
      await writeFile(created, "external");
      throw Object.assign(new Error("Changed before publication"), { effect: "not-applied" });
    }
    await restoreLocalFileState(state);
  });
  const receipt = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);
  await expect(store.restore(receipt)).rejects.toMatchObject({
    code: "APPLY_UNDO_FAILED",
    rollbackErrors: [],
  });
  expect(await readFile(edited, "utf8")).toBe("after");
  expect(await readFile(created, "utf8")).toBe("external");
  expect(store.has(receipt)).toBe(false);
});
test("rolls back a partially failed undo", async () => {
  const { edited, created, before } = await fixture();
  let restoreCount = 0;
  const store = new ApplyUndoStore(async (state) => {
    restoreCount += 1;
    if (restoreCount === 2) throw new Error("injected restore failure");
    await restoreLocalFileState(state);
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

test("undo refuses a change between receipt validation and restoration", async () => {
  const { edited, before } = await fixture();
  await writeFile(edited, "after");
  let captures = 0;
  const store = new ApplyUndoStore(undefined, async (source) => {
    captures += 1;
    if (captures === 3) await writeFile(source, "external");
    return { path: source, existed: true, bytes: await readFile(source) };
  });
  const receipt = await store.record([{ path: edited, existed: true, bytes: before }]);
  await expect(store.restore(receipt)).rejects.toMatchObject({ code: "APPLY_UNDO_STALE" });
  expect(await readFile(edited, "utf8")).toBe("external");
});

test("undo compensation refuses an external edit to an already restored path", async () => {
  const { edited, created, before } = await fixture();
  await writeFile(edited, "after");
  await writeFile(created, "created");
  let restores = 0;
  const store = new ApplyUndoStore(async (state) => {
    restores += 1;
    if (restores === 2) {
      await writeFile(edited, "external");
      throw Object.assign(new Error("Second path refused"), { effect: "not-applied" });
    }
    if (state.existed) await writeFile(state.path, state.bytes ?? new Uint8Array());
    else await rm(state.path, { force: true });
  });
  const receipt = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);
  try {
    await expect(store.restore(receipt)).rejects.toMatchObject({
      code: "APPLY_UNDO_FAILED",
      rollbackErrors: [expect.stringContaining("changed")],
      recovery: receipt,
    });
    expect(store.has(receipt)).toBe(true);
    await expect(store.restore(receipt)).rejects.toMatchObject({ code: "APPLY_UNDO_STALE" });
    expect(store.has(receipt)).toBe(true);
    expect(await readFile(edited, "utf8")).toBe("external");
    expect(await readFile(created, "utf8")).toBe("created");
  } finally {
    await store.dispose();
  }
});
test("canceling undo between participants compensates completed restorations", async () => {
  const { edited, created, before } = await fixture();
  await writeFile(edited, "after");
  await writeFile(created, "created");
  const controller = new AbortController();
  let restores = 0;
  const store = new ApplyUndoStore(async (state) => {
    await restoreLocalFileState(state);
    restores += 1;
    if (restores === 1) controller.abort();
  });
  const receipt = await store.record([
    { path: edited, existed: true, bytes: before },
    { path: created, existed: false },
  ]);
  await expect(store.restore(receipt, controller.signal)).rejects.toMatchObject({
    code: "APPLY_UNDO_FAILED",
    rollbackErrors: [],
  });
  expect(await readFile(edited, "utf8")).toBe("after");
  expect(await readFile(created, "utf8")).toBe("created");
});
test("a failed compensation keeps guarded snapshots for a later recovery attempt", async () => {
  const { edited, created, before } = await fixture();
  await writeFile(created, "original");
  const original = [await captureLocalFileState(edited), await captureLocalFileState(created)];
  await writeFile(edited, "after");
  await writeFile(created, "created");
  let restores = 0;
  const store = new ApplyUndoStore(async (state) => {
    restores += 1;
    if (restores === 2 || restores === 3)
      throw Object.assign(new Error("Owner temporarily unavailable"), { effect: "not-applied" });
    await restoreLocalFileState(state);
  });
  try {
    const receipt = await store.record(original);
    await expect(store.restore(receipt)).rejects.toMatchObject({
      code: "APPLY_UNDO_FAILED",
      rollbackErrors: [expect.stringContaining("unavailable")],
    });
    expect(store.has(receipt)).toBe(true);
    await expect(store.restore(receipt)).resolves.toMatchObject({ restored: [edited, created] });
    expect((await readFile(edited)).equals(before)).toBe(true);
    expect(await readFile(created, "utf8")).toBe("original");
    expect(store.has(receipt)).toBe(false);
  } finally {
    await store.dispose();
  }
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

test("journal cleanup failures retain release ownership and disposal retries them", async () => {
  const { edited } = await fixture();
  const original = await captureLocalFileState(edited);
  if (original.backup === undefined) throw new Error("Missing disk backup");
  const backup = original.backup;
  let releases = 0;
  const store = new ApplyUndoStore();
  const receipt = await store.record([
    {
      ...original,
      backup: {
        sha256: backup.sha256,
        async release() {
          releases += 1;
          if (releases === 1) throw new Error("Journal owner temporarily unavailable");
          await backup.release();
        },
      },
    },
  ]);
  try {
    store.invalidate(new Set([edited]));
    expect(store.has(receipt)).toBe(false);
    await expect(store.dispose()).resolves.toBeUndefined();
    expect(releases).toBe(2);
  } finally {
    await backup.release();
  }
});

test("completed undo reports applied when journal cleanup fails", async () => {
  const { edited, before } = await fixture();
  const original = await captureLocalFileState(edited);
  if (original.backup === undefined) throw new Error("Missing disk backup");
  const backup = original.backup;
  let releaseRefused = true;
  const wrapped = {
    ...original,
    backup: {
      sha256: backup.sha256,
      async release() {
        if (releaseRefused) throw new Error("Cleanup unavailable");
        await backup.release();
      },
    },
  };
  const store = new ApplyUndoStore(async (state, signal) => {
    await restoreLocalFileState(
      state === wrapped || state.backup === wrapped.backup ? original : state,
      signal,
    );
  });
  await writeFile(edited, "after");
  const receipt = await store.record([wrapped]);
  try {
    await expect(store.restore(receipt)).rejects.toMatchObject({
      code: "APPLY_UNDO_CLEANUP_FAILED",
      effect: "applied",
      restored: [edited],
    });
    expect((await readFile(edited)).equals(before)).toBe(true);
    expect(store.has(receipt)).toBe(false);
  } finally {
    releaseRefused = false;
    await store.dispose();
    await backup.release();
  }
});
