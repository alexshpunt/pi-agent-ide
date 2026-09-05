import { expect, test } from "vitest";

import {
  type ContentConversionAttempt,
  type ContentConverter,
  type ContentInput,
  type ContentTarget,
  createContentRunner,
  UnsupportedContentError,
} from "pi-agent-resource";

const target = { provider: "fixture", capability: "read" } satisfies ContentTarget;
const input = { source: "fixture://value", bytes: new Uint8Array([1]) } satisfies ContentInput;

test("runs converters serially by stable priority and stops after conversion", async () => {
  const calls: string[] = [];
  const runner = createContentRunner(target);

  runner.register(
    registration("late", 20, async () => {
      calls.push("late");
      return { kind: "converted", content: [{ type: "text", text: "done" }] };
    }),
  );
  runner.register(
    registration("first-equal", 10, async () => {
      calls.push("first-equal:start");
      await Promise.resolve();
      calls.push("first-equal:end");
      return { kind: "not-handled" };
    }),
  );
  runner.register(
    registration("second-equal", 10, async () => {
      calls.push("second-equal");
      return { kind: "not-handled" };
    }),
  );
  runner.register(
    registration("never", 30, async () => {
      calls.push("never");
      return { kind: "converted", content: [{ type: "text", text: "wrong" }] };
    }),
  );

  await expect(runner.convert(input, {})).resolves.toEqual([{ type: "text", text: "done" }]);
  expect(calls).toEqual(["first-equal:start", "first-equal:end", "second-equal", "late"]);
});

test("treats failed and malformed outcomes as terminal", async () => {
  const failure = new Error("broken conversion");
  const failedRunner = createContentRunner(target);
  let fallbackCalls = 0;

  failedRunner.register(
    registration("failed", 0, async () => ({ kind: "failed", error: failure })),
  );
  failedRunner.register(
    registration("fallback", 1, async () => {
      fallbackCalls += 1;
      return { kind: "converted", content: [{ type: "text", text: "fallback" }] };
    }),
  );

  await expect(failedRunner.convert(input, {})).rejects.toBe(failure);
  expect(fallbackCalls).toBe(0);

  const malformedRunner = createContentRunner(target);
  malformedRunner.register(
    registration("malformed", 0, async () =>
      asContentConversionAttempt({ kind: "converted", content: [] }),
    ),
  );
  malformedRunner.register(
    registration("fallback", 1, async () => {
      fallbackCalls += 1;
      return { kind: "converted", content: [{ type: "text", text: "fallback" }] };
    }),
  );

  await expect(malformedRunner.convert(input, {})).rejects.toThrow(
    "Content converter malformed returned an invalid outcome",
  );
  expect(fallbackCalls).toBe(0);
});

test("snapshots registrations and rejects duplicate converter IDs per target", async () => {
  const runner = createContentRunner(target);
  const added = converter("added", async () => ({
    kind: "converted",
    content: [{ type: "text", text: "added" }],
  }));
  let installed = false;

  runner.register({
    target,
    converter: converter("initial", async () => {
      if (!installed) {
        installed = true;
        runner.register({ target, converter: added });
      }

      return { kind: "not-handled" };
    }),
  });

  await expect(runner.convert(input, {})).rejects.toBeInstanceOf(UnsupportedContentError);
  await expect(runner.convert(input, {})).resolves.toEqual([{ type: "text", text: "added" }]);
  expect(() => runner.register({ target, converter: added })).toThrow("already registered");

  const writeRunner = createContentRunner({ provider: "fixture", capability: "write" });
  expect(() =>
    writeRunner.register({
      target: { provider: "fixture", capability: "write" },
      converter: added,
    }),
  ).not.toThrow();
});

test("lists target-local descriptions by conversion order without exposing runner state", () => {
  const runner = createContentRunner(target);
  runner.register(registration("late", 20, async () => ({ kind: "not-handled" })));
  runner.register(registration("first-equal", 10, async () => ({ kind: "not-handled" })));
  runner.register(registration("second-equal", 10, async () => ({ kind: "not-handled" })));

  const snapshot = runner.listDescriptions();
  expect(snapshot.map(({ id }) => id)).toEqual(["first-equal", "second-equal", "late"]);

  (snapshot as { id: string; description: string }[])[0] = {
    id: "changed",
    description: "Changed.",
  };
  expect(runner.listDescriptions()[0]?.id).toBe("first-equal");

  const writeRunner = createContentRunner({ provider: "fixture", capability: "write" });
  expect(writeRunner.listDescriptions()).toEqual([]);
});
test("stops for cancellation and reports unsupported content", async () => {
  const runner = createContentRunner(target);
  const controller = new AbortController();
  let secondCalls = 0;

  runner.register(
    registration("aborting", 0, async () => {
      controller.abort();
      return { kind: "not-handled" };
    }),
  );
  runner.register(
    registration("never", 1, async () => {
      secondCalls += 1;
      return { kind: "converted", content: [{ type: "text", text: "wrong" }] };
    }),
  );

  await expect(runner.convert(input, { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(secondCalls).toBe(0);

  const emptyRunner = createContentRunner(target);
  await expect(emptyRunner.convert(input, {})).rejects.toMatchObject({
    name: "UnsupportedContentError",
    source: input.source,
    target,
  });
});

function converter(id: string, tryConvert: ContentConverter["tryConvert"]): ContentConverter {
  return { id, description: `${id} content.`, tryConvert };
}

function registration(id: string, priority: number, tryConvert: ContentConverter["tryConvert"]) {
  return { target, priority, converter: converter(id, tryConvert) };
}

function asContentConversionAttempt(value: unknown): ContentConversionAttempt {
  return value as ContentConversionAttempt;
}
