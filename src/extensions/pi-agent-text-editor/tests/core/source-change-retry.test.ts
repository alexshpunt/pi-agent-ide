import { expect, test } from "vitest";

import {
  RETRY_BUDGET_MS,
  retryWhenSourceChanged,
  SOURCE_CHANGED,
  SourceKeptChangingError,
} from "#src/core/source-change-retry.ts";
import type { TextResourcesEditOutcome } from "#src/core/text-editor-core.ts";

const changed: TextResourcesEditOutcome<string> = {
  kind: "failed",
  completed: [],
  failure: {
    code: "INVALID_REQUEST",
    source: "SEARCH#51AC:all:match",
    message: "The selected source changed before editing. Resolve the symbol again.",
    cause: Object.assign(new Error("changed"), { code: SOURCE_CHANGED }),
  },
};
const applied: TextResourcesEditOutcome<string> = {
  kind: "completed",
  resources: [],
  result: "done",
};

/** A clock that advances by `costMs` per attempt and by each pause. */
function timing(costMs: number) {
  let time = 0;
  return {
    tick: () => (time += costMs),
    timing: {
      now: () => time,
      sleep: (milliseconds: number) => {
        time += milliseconds;
        return Promise.resolve();
      },
    },
  };
}

test("an edit whose file changed runs again and succeeds once the file holds still", async () => {
  const clock = timing(100);
  let attempts = 0;
  const outcome = await retryWhenSourceChanged(() => {
    clock.tick();
    attempts += 1;
    return Promise.resolve(attempts < 3 ? changed : applied);
  }, clock.timing);
  expect(outcome).toBe(applied);
  expect(attempts).toBe(3);
});

test("slow attempts stop at the time budget with a reason that names the other writer", async () => {
  const clock = timing(3_000);
  let attempts = 0;
  const outcome = await retryWhenSourceChanged(() => {
    clock.tick();
    attempts += 1;
    return Promise.resolve(changed);
  }, clock.timing);
  expect(attempts).toBeLessThan(8);
  // The budget runs from the first attempt that found newer text; the last attempt may start
  // just before it ends.
  expect(clock.timing.now()).toBeLessThanOrEqual(3_000 + RETRY_BUDGET_MS + 3_000);
  if (outcome.kind !== "failed") throw new Error("Expected a failure");
  expect(outcome.failure.cause).toBeInstanceOf(SourceKeptChangingError);
  expect(outcome.failure.cause).toMatchObject({ attempts, cause: changed.failure.cause });
  expect(outcome.failure.message).toContain("Another process kept writing the file");
  expect(outcome.failure.message).toContain(`each of ${String(attempts)} attempts`);
  expect(outcome.failure.message).toContain("nothing was written");
});

test("fast attempts stop after the last pause with the same reason", async () => {
  const clock = timing(10);
  let attempts = 0;
  const outcome = await retryWhenSourceChanged(() => {
    clock.tick();
    attempts += 1;
    return Promise.resolve(changed);
  }, clock.timing);
  expect(attempts).toBe(8);
  expect(outcome.kind === "failed" && outcome.failure.message).toContain("each of 8 attempts");
});

test("other failures return at once and unchanged", async () => {
  const other: TextResourcesEditOutcome<string> = {
    kind: "failed",
    completed: [],
    failure: { code: "INVALID_REQUEST", source: "a.txt", message: "anchor is stale" },
  };
  let attempts = 0;
  const outcome = await retryWhenSourceChanged(() => {
    attempts += 1;
    return Promise.resolve(other);
  }, timing(10).timing);
  expect(outcome).toBe(other);
  expect(attempts).toBe(1);
});
