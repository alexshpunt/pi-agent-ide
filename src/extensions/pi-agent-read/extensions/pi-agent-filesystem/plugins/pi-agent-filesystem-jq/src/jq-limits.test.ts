import { expect, test } from "vitest";

import { executeJq } from "#src/jq.js";

test("jq rejects output above its byte cap without returning a partial value", async () => {
  const bytes = 10 * 1024 * 1024;
  const below = await executeJq(`"x" * ${bytes - 100}`, "{}", { cwd: process.cwd() });
  const value: unknown = JSON.parse(below);
  if (typeof value !== "string") throw new Error("Expected one JSON string");
  expect(value.length).toBe(bytes - 100);
  expect(Buffer.byteLength(below)).toBeLessThan(bytes);
  await expect(executeJq(`"x" * ${bytes}`, "{}", { cwd: process.cwd() })).rejects.toBeInstanceOf(
    Error,
  );
}, 15000);

test("jq stops a nonterminating filter before the independent cancellation watchdog", async () => {
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 9000);
  const started = performance.now();
  try {
    await expect(
      executeJq("until(false; .)", "{}", { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4000);
  } finally {
    clearTimeout(watchdog);
  }
}, 15000);

test("jq cancels an active processor", async () => {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 100);
  try {
    await expect(
      executeJq("until(false; .)", "{}", { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(true);
  } finally {
    clearTimeout(abort);
  }
});
