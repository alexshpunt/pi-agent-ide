import { readFile, stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { TempResourceStore } from "./temp-resource-store.js";

test("keeps complete private files until disposal, including saves already in flight", async () => {
  const store = new TempResourceStore();
  const full = "😀".repeat(30000) + "\nFINAL_ROW";
  const saving = store.saveFile(full);
  const file = await saving;
  expect((await readFile(file, "utf8")) === full).toBe(true);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const pending = store.saveFile("last saved output");
  const disposed = store.dispose();
  const lastFile = await pending;
  await disposed;
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(lastFile)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.saveFile("late")).rejects.toThrow("closed");
});
