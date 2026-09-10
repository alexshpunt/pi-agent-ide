import { expect, test } from "vitest";
import { ApplyQueue } from "#src/core/apply/queue.js";

test("concurrent submissions observe prior writes and recover after rejection", async () => {
  const queue = new ApplyQueue();
  let content = "before";
  const write = queue.submit(async () => {
    await Promise.resolve();
    content = "after";
  });
  const refusal = queue.submit(async () => {
    throw new Error("refused");
  });
  const read = queue.submit(async () => content);
  const outcomes = await Promise.allSettled([write, refusal, read]);
  expect(outcomes).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: new Error("refused") },
    { status: "fulfilled", value: "after" },
  ]);
  await queue.close();
});

test("closing drains active work but prevents queued effects", async () => {
  const queue = new ApplyQueue();
  const effects: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = queue.submit(async () => {
    await gate;
    effects.push("active");
  });
  await Promise.resolve();
  const queued = queue.submit(async () => {
    effects.push("queued");
  });
  const queuedFailure = expect(queued).rejects.toBeInstanceOf(Error);
  let drained = false;
  const closing = queue.close().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await Promise.all([active, queuedFailure, closing]);
  expect(effects).toEqual(["active"]);
  await expect(queue.submit(async () => effects.push("late"))).rejects.toBeInstanceOf(Error);
});
