import { expect, test } from "vitest";
import { SharedStartup } from "./abort.js";

test("the last cancelled waiter keeps its cancellation and failed startup cleanup", async () => {
  const cancelled = new Error("Cancel my startup");
  const cleanup = new Error("Owned startup stop failed");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startup = new SharedStartup<void>(async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await gate;
    throw cleanup;
  });
  const controller = new AbortController();
  let finished = false;
  const pending = startup.wait(controller.signal);
  const observed = pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    controller.abort(cancelled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release?.();
    await expect(pending).rejects.toMatchObject({
      name: "AggregateError",
      errors: [cancelled, cleanup],
    });
  } finally {
    release?.();
    await observed;
  }
});
