import { expect, test } from "vitest";

import { retryWhileSourceChanges, sourceChanged } from "./source-changes.js";

test("a search that met a concurrent write runs again on the current text", async () => {
  let attempts = 0;
  const result = await retryWhileSourceChanges(() => {
    attempts += 1;
    if (attempts < 3) throw sourceChanged("LSP source changed during search.");
    return Promise.resolve("found");
  }, undefined);

  expect(result).toBe("found");
  expect(attempts).toBe(3);
});

test("other failures and a file that keeps changing are reported", async () => {
  let attempts = 0;
  await expect(
    retryWhileSourceChanges(() => {
      attempts += 1;
      throw new Error("server crashed");
    }, undefined),
  ).rejects.toThrow("server crashed");
  expect(attempts).toBe(1);

  attempts = 0;
  await expect(
    retryWhileSourceChanges(() => {
      attempts += 1;
      throw sourceChanged("LSP source changed during search.");
    }, undefined),
  ).rejects.toThrow("LSP source changed during search.");
  expect(attempts).toBe(5);
});
