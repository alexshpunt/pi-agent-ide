import { expect, test } from "vitest";
import { schedule } from "#capabilities/scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("bounds work and publishes completed results in selection order", async () => {
  const gates = [deferred<number>(), deferred<number>(), deferred<number>()] as const;
  const started: number[] = [];
  const reports: number[][] = [];
  const running = schedule([0, 1, 2], 2, new AbortController(), {
    run: async (item) => {
      started.push(item);
      const gate = gates[item];
      if (gate === undefined) throw new Error("Unknown scheduled item");
      return gate.promise;
    },
    publish: async (results) => {
      reports.push([...results]);
    },
    stopReason: () => undefined,
    resource: () => undefined,
  });
  await viWait(() => started.length === 2);
  expect(started).toEqual([0, 1]);
  gates[1].resolve(1);
  await viWait(() => started.length === 3);
  expect(reports).toEqual([[1]]);
  gates[2].resolve(2);
  await viWait(() => reports.length === 2);
  gates[0].resolve(0);
  await running;
  expect(reports).toEqual([[1], [1, 2], [0, 1, 2]]);
});

test("serializes shared resources while unrelated work proceeds", async () => {
  const gates = [deferred<number>(), deferred<number>(), deferred<number>()] as const;
  const started: number[] = [];
  const running = schedule([0, 1, 2], 2, new AbortController(), {
    run: async (item) => {
      started.push(item);
      const gate = gates[item];
      if (gate === undefined) throw new Error("Unknown scheduled item");
      return gate.promise;
    },
    publish: async () => {},
    stopReason: () => undefined,
    resource: (item) => (item < 2 ? "web" : undefined),
  });
  await viWait(() => started.length === 2);
  expect(started).toEqual([0, 2]);
  gates[0].resolve(0);
  await viWait(() => started.length === 3);
  expect(started).toEqual([0, 2, 1]);
  gates[1].resolve(1);
  gates[2].resolve(2);
  await running;
});

test("account stop aborts and drains active work without starting more", async () => {
  const gate = deferred<string>();
  const started: number[] = [];
  const controller = new AbortController();
  const reports: string[][] = [];
  const running = schedule([0, 1, 2], 2, controller, {
    run: async (item, signal) => {
      started.push(item);
      if (item === 0) return gate.promise;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "cancelled";
    },
    publish: async (results) => {
      reports.push([...results]);
    },
    stopReason: (result) => (result === "limit" ? "account-limit" : undefined),
    resource: () => undefined,
  });
  gate.resolve("limit");
  const result = await running;
  expect(started).toEqual([0, 1]);
  expect(controller.signal.aborted).toBe(true);
  expect(result.stoppedFor).toBe("account-limit");
  expect(reports.at(-1)).toEqual(["limit", "cancelled"]);
});

test("a stop completing during publication prevents refilling the queue", async () => {
  const gates = [deferred<string>(), deferred<string>()] as const;
  const publishing = deferred<void>();
  const release = deferred<void>();
  const started: number[] = [];
  const controller = new AbortController();
  const running = schedule([0, 1, 2], 2, controller, {
    run: async (item) => {
      started.push(item);
      const gate = gates[item];
      if (gate === undefined) throw new Error("Unknown scheduled item");
      return gate.promise;
    },
    resource: () => undefined,
    stopReason: (result) => (result === "limit" ? "account-limit" : undefined),
    publish: async (results) => {
      if (results.length === 1) {
        publishing.resolve();
        await release.promise;
      }
    },
  });
  await viWait(() => started.length === 2);
  gates[0].resolve("ok");
  await publishing.promise;
  gates[1].resolve("limit");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.signal.aborted).toBe(true);
  release.resolve();
  const result = await running;
  expect(result.stoppedFor).toBe("account-limit");
  expect(started).toEqual([0, 1]);
});

test("external cancellation drains active work and skips the queue", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const reports: number[][] = [];
  const running = schedule([0, 1, 2], 2, controller, {
    run: async (item, signal) => {
      started.push(item);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return item;
    },
    resource: () => undefined,
    stopReason: () => undefined,
    publish: async (results) => {
      reports.push([...results]);
    },
  });
  await viWait(() => started.length === 2);
  controller.abort();
  await running;
  expect(started).toEqual([0, 1]);
  expect(reports.at(-1)).toEqual([0, 1]);
});

test("an unexpected failure aborts and waits for active cleanup", async () => {
  const gate = deferred<void>();
  const cleaned = deferred<void>();
  const controller = new AbortController();
  let drained = false;
  const running = schedule([0, 1, 2], 2, controller, {
    run: async (item, signal) => {
      if (item === 0) {
        await gate.promise;
        throw new Error("failure");
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await cleaned.promise;
      drained = true;
      return item;
    },
    resource: () => undefined,
    stopReason: () => undefined,
    publish: async () => {},
  });
  gate.resolve();
  await viWait(() => controller.signal.aborted);
  expect(drained).toBe(false);
  cleaned.resolve();
  await expect(running).rejects.toThrow("failure");
  expect(drained).toBe(true);
});

test("publication failure aborts and drains active attempts", async () => {
  const first = deferred<void>();
  const cleaned = deferred<void>();
  const controller = new AbortController();
  let drained = false;
  const running = schedule([0, 1, 2], 2, controller, {
    run: async (item, signal) => {
      if (item === 0) {
        await first.promise;
        return item;
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await cleaned.promise;
      drained = true;
      return item;
    },
    resource: () => undefined,
    stopReason: () => undefined,
    publish: async () => {
      throw new Error("report failed");
    },
  });
  first.resolve();
  await viWait(() => controller.signal.aborted);
  expect(drained).toBe(false);
  cleaned.resolve();
  await expect(running).rejects.toThrow("report failed");
  expect(drained).toBe(true);
});

async function viWait(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}
