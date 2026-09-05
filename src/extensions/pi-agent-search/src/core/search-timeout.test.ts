import { expect, test, vi } from "vitest";

import { runWithSearchTimeout, SearchTimeoutError } from "#src/core/search-timeout.js";

test("fails and aborts a search that exceeds its timeout", async () => {
  vi.useFakeTimers();
  let operationSignal: AbortSignal | undefined;
  const result = runWithSearchTimeout(30_000, undefined, (signal) => {
    operationSignal = signal;
    return new Promise<string>(() => {});
  });

  const rejection = expect(result).rejects.toEqual(
    new SearchTimeoutError("Search timed out after 30 seconds. Try a smaller path scope."),
  );
  await vi.advanceTimersByTimeAsync(30_000);

  await rejection;
  expect(operationSignal?.aborted).toBe(true);
  vi.useRealTimers();
});

test("supports disabling the timeout", async () => {
  await expect(runWithSearchTimeout(null, undefined, async () => "finished")).resolves.toBe(
    "finished",
  );
});

test("forwards parent cancellation to the search operation", async () => {
  const parent = new AbortController();
  const reason = new Error("cancelled by Pi");
  const result = runWithSearchTimeout(30_000, parent.signal, async (signal) => {
    return await new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });

  parent.abort(reason);

  await expect(result).rejects.toBe(reason);
});
