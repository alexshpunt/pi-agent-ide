import { expect, test, vi } from "vitest";
import { ResourceScheduler } from "./resource-scheduler.ts";
import { runWithinToolDeadline } from "./tool-deadline.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("disjoint writes and shared reads overlap while conflicting work keeps submission order", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const entered = gate();
  const order: string[] = [];
  const first = scheduler.run([{ resource: "a", mode: "write" }], async () => {
    order.push("first");
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const next = scheduler.run([{ resource: "a", mode: "read" }], () => {
    order.push("next");
  });
  await scheduler.run([{ resource: "b", mode: "write" }], () => {
    order.push("other");
  });
  expect(order).toEqual(["first", "other"]);
  release.resolve();
  await Promise.all([first, next]);
  expect(order).toEqual(["first", "other", "next"]);

  const readers = gate();
  const reader = scheduler.run([{ resource: "a", mode: "read" }], () => readers.promise);
  await scheduler.run([{ resource: "a", mode: "read" }], () => {
    order.push("reader");
  });
  readers.resolve();
  await reader;
});

test("partially overlapping sets queue without blocking disjoint work or deadlocking", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const first = scheduler.run([{ resource: "a", mode: "write" }], () => release.promise);
  const second = scheduler.run(
    [
      { resource: "a", mode: "write" },
      { resource: "b", mode: "write" },
    ],
    () => "second",
  );
  let thirdRan = false;
  const third = scheduler.run([{ resource: "b", mode: "write" }], () => {
    thirdRan = true;
  });
  await scheduler.run([{ resource: "c", mode: "write" }], () => undefined);
  expect(thirdRan).toBe(false);
  release.resolve();
  expect(await second).toBe("second");
  await Promise.all([first, third]);
});

test("a directory read conflicts with child writes but not similarly named siblings", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const reader = scheduler.run(
    [{ resource: "file:///project/src", mode: "read", recursive: true }],
    () => release.promise,
  );
  let childRan = false;
  const child = scheduler.run([{ resource: "file:///project/src/file.ts", mode: "write" }], () => {
    childRan = true;
  });
  await scheduler.run(
    [{ resource: "file:///project/src-other/file.ts", mode: "write" }],
    () => undefined,
  );
  try {
    expect(childRan).toBe(false);
  } finally {
    release.resolve();
    await Promise.all([reader, child]);
  }
});
test("cancelling a queued operation rejects without waiting for its active dependency", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const first = scheduler.run([{ resource: "a", mode: "write" }], () => release.promise);
  const controller = new AbortController();
  let cancelledRan = false;
  const cancelled = scheduler.run(
    [{ resource: "a", mode: "write" }],
    () => {
      cancelledRan = true;
    },
    controller.signal,
  );
  controller.abort(new Error("cancelled"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        cancelled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Cancellation waited for an unrelated release")),
            500,
          );
        }),
      ]),
    ).rejects.toThrow("cancelled");
    expect(cancelledRan).toBe(false);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await Promise.allSettled([first, cancelled]);
  }
});
test("a stalled write expires with its resource and never runs after the owner releases it", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const access = [{ resource: "file:///workspace/shared.txt", mode: "write" }] as const;
  let ownerFinished = false;
  let expiredRan = false;
  const owner = scheduler.run(
    access,
    async () => {
      await release.promise;
      ownerFinished = true;
    },
    undefined,
    { waitTimeoutMs: 50 },
  );
  const expired = scheduler.run(
    access,
    () => {
      expiredRan = true;
    },
    undefined,
    { waitTimeoutMs: 50 },
  );
  try {
    await expect(expired).rejects.toMatchObject({
      code: "RESOURCE_WAIT_TIMEOUT",
      resources: ["file:///workspace/shared.txt"],
    });
    expect(ownerFinished).toBe(false);
  } finally {
    release.resolve();
    await owner;
  }
  await expect(scheduler.run(access, () => "next")).resolves.toBe("next");
  expect(ownerFinished).toBe(true);
  expect(expiredRan).toBe(false);
});

test("known resources can wait longer without extending unresolved waits or the caller deadline", async () => {
  vi.useFakeTimers();
  const scheduler = new ResourceScheduler();
  const release = gate();
  const started = gate();
  const file = [{ resource: "file:/shared", mode: "write" }] as const;
  const policy = {
    waitTimeoutMs: 20,
    waitTimeoutForAccesses: () => 100,
  };
  const owner = scheduler.run(file, async () => {
    started.resolve();
    await release.promise;
  });
  const writes: string[] = [];
  try {
    await started.promise;
    const waiting = scheduler.run(file, () => writes.push("waiting"), undefined, policy);
    const cancelled = runWithinToolDeadline(
      "replace",
      "shared",
      50,
      undefined,
      "not-applied",
      (signal) => scheduler.run(file, () => writes.push("cancelled"), signal, policy),
      (error) => error,
    );
    const unresolved = scheduler.run(
      gate().promise.then(() => file),
      () => writes.push("unresolved"),
      undefined,
      policy,
    );
    const outcomes = Promise.allSettled([waiting, cancelled, unresolved]);
    await vi.advanceTimersByTimeAsync(55);
    expect(writes).toEqual([]);
    release.resolve();
    await expect(outcomes).resolves.toMatchObject([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: { code: "TOOL_TIMEOUT", effect: "not-applied" } },
      { status: "rejected", reason: { code: "RESOURCE_WAIT_TIMEOUT" } },
    ]);
    expect(writes).toEqual(["waiting"]);
  } finally {
    release.resolve();
    await owner;
    vi.useRealTimers();
  }
});

test("a helper read borrows its parent's reservation instead of waiting for itself", async () => {
  const scheduler = new ResourceScheduler();
  const nested = scheduler.run([{ resource: "a", mode: "write" }], () =>
    scheduler.run([{ resource: "a", mode: "read" }], () => "current"),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        nested,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Helper waited for its own writer")), 500);
        }),
      ]),
    ).resolves.toBe("current");
  } finally {
    clearTimeout(timer);
  }
});

test("a borrowed read keeps protection when its caller does not await it", async () => {
  const scheduler = new ResourceScheduler();
  const entered = gate();
  const release = gate();
  const parent = scheduler.run([{ resource: "a", mode: "write" }], () => {
    void scheduler.run([{ resource: "a", mode: "read" }], async () => {
      entered.resolve();
      await release.promise;
    });
  });
  await entered.promise;
  let writerRan = false;
  const writer = scheduler.run([{ resource: "a", mode: "write" }], () => {
    writerRan = true;
  });
  await scheduler.run([{ resource: "b", mode: "read" }], () => undefined);
  try {
    expect(writerRan).toBe(false);
  } finally {
    release.resolve();
    await Promise.all([parent, writer]);
  }
});
test("transaction children overlap on disjoint resources and order conflicting writes", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const entered = gate();
  const order: string[] = [];
  await scheduler.run(
    [
      { resource: "a", mode: "write" },
      { resource: "b", mode: "write" },
    ],
    async () => {
      const first = scheduler.run([{ resource: "a", mode: "write" }], async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const second = scheduler.run([{ resource: "a", mode: "write" }], () => {
        order.push("second");
      });
      try {
        await scheduler.run([{ resource: "b", mode: "write" }], () => {
          order.push("other");
        });
        expect(order).toEqual(["first", "other"]);
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
    },
    undefined,
    { allowNestedWrites: true },
  );
  expect(order).toEqual(["first", "other", "second"]);
});

test("a helper can borrow a hard-link identity without owning its other path", async () => {
  const scheduler = new ResourceScheduler();
  await expect(
    scheduler.run(
      [
        { resource: "file:///a", group: "file:///a", mode: "write" },
        { resource: "inode:1:2", group: "file:///a", mode: "write" },
      ],
      () =>
        scheduler.run(
          [
            { resource: "file:///alias", group: "file:///alias", mode: "read" },
            { resource: "inode:1:2", group: "file:///alias", mode: "read" },
          ],
          () => "covered",
        ),
    ),
  ).resolves.toBe("covered");
});
test("nested helpers cannot silently expand a complete resource reservation", async () => {
  const scheduler = new ResourceScheduler();
  await expect(
    scheduler.run([{ resource: "a", mode: "write" }], () =>
      scheduler.run([{ resource: "b", mode: "read" }], () => "undeclared"),
    ),
  ).rejects.toThrow("reservation");
});
test("unknown sets are exclusive and rejected operations release their place", async () => {
  const scheduler = new ResourceScheduler();
  const release = gate();
  const first = scheduler.run([{ resource: "a", mode: "read" }], () => release.promise);
  const failure = scheduler.run(undefined, () => {
    throw new Error("refused");
  });
  const caught = failure.catch((error: unknown) => error);
  let lastRan = false;
  const last = scheduler.run([{ resource: "b", mode: "read" }], () => {
    lastRan = true;
  });
  await Promise.resolve();
  expect(lastRan).toBe(false);
  release.resolve();
  await first;
  expect(await caught).toBeInstanceOf(Error);
  await last;
  expect(lastRan).toBe(true);
});
