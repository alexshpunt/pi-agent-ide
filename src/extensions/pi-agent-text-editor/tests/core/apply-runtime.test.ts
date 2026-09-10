import { expect, test } from "vitest";
import { executeApplySource } from "#src/core/apply/runtime.js";

test("direct globals compose sequentially and explicit output needs no return", async () => {
  const calls: string[] = [];
  const output: unknown[] = [];
  let content = "before";
  await executeApplySource(
    'const [, doc] = [replace({text: "after"}), read({})]; result(doc); remove({});',
    {
      async execute(operation) {
        calls.push(operation);
        if (operation === "replace") {
          await Promise.resolve();
          content = "after";
        }
        return { content };
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(calls).toEqual(["replace", "read", "remove"]);
  expect(output).toEqual([{ content: "after" }]);
});

test("guest can recover from a refused operation without losing prior effects", async () => {
  const calls: string[] = [];
  await executeApplySource("write({}); try { replace({}); } catch {} read({});", {
    async execute(operation) {
      calls.push(operation);
      if (operation === "replace") throw new Error("refused");
      return null;
    },
    async result() {},
  });
  expect(calls).toEqual(["write", "replace", "read"]);
});

test("operation errors retain structured recovery data inside the guest", async () => {
  const output: unknown[] = [];
  await executeApplySource(
    "try { replace({}); } catch (error) { result({code: error.code, details: error.details}); }",
    {
      async execute() {
        throw Object.assign(new Error("stale"), {
          code: "STALE_ANCHOR",
          details: { effect: "not-applied", candidates: ["12#ABCD"] },
        });
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(output).toEqual([
    { code: "STALE_ANCHOR", details: { effect: "not-applied", candidates: ["12#ABCD"] } },
  ]);
});

test("explicit operation output keeps its host identity, copied values do not", async () => {
  const identities: (string | undefined)[] = [];
  let callId: string | undefined;
  await executeApplySource("const doc = read({}); result(doc); result({...doc});", {
    async execute(_operation, _args, _signal, id) {
      callId = id;
      return { content: "text" };
    },
    async result(_value, id) {
      identities.push(id);
    },
  });
  expect(callId).toEqual(expect.any(String));
  expect(identities).toEqual([callId, undefined]);
});

test("cancellation drains an active operation and prevents queued operations", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let finished = false;
  const execution = executeApplySource(
    "await Promise.all([write({}), replace({})]);",
    {
      async execute(operation, _args, signal) {
        calls.push(operation);
        controller.abort();
        await Promise.resolve();
        finished = true;
        signal.throwIfAborted();
        return null;
      },
      async result() {},
    },
    controller.signal,
  );
  await expect(execution).rejects.toBeInstanceOf(Error);
  expect(finished).toBe(true);
  expect(calls).toEqual(["write"]);
});

test("synchronous reads transfer large data without clipping", async () => {
  const content = "x".repeat(2 * 1024 * 1024);
  const output: unknown[] = [];
  await executeApplySource(
    "const doc = read({}); result({length: doc.content.length, last: doc.content.at(-1)});",
    {
      async execute() {
        return { content };
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(output).toEqual([{ length: content.length, last: "x" }]);
});

test("synchronous bridge timeout aborts host work before another operation", async () => {
  const calls: string[] = [];
  let aborted = false;
  await expect(
    executeApplySource(
      "read({}); write({});",
      {
        async execute(operation, _args, signal) {
          calls.push(operation);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          aborted = signal.aborted;
          signal.throwIfAborted();
          return null;
        },
        async result() {},
      },
      undefined,
      { timeoutMs: 1000 },
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(aborted).toBe(true);
  expect(calls).toEqual(["read"]);
});
