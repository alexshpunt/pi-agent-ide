import { expect, test } from "vitest";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import { FileMutationResult } from "#src/api/mutation-result.js";
import { mutationOutcome } from "#src/core/structured-result.js";

const source = "/workspace/note.txt";
const completion: TextEditCompletion = {
  source,
  resourceSource: source,
  cwd: "/workspace",
  resolvedBy: "fixture",
  existed: true,
  intent: "edit",
  before: {
    source,
    content: "before\n",
    lines: [{ lineNumber: 1, content: "before", lineEnding: "\n" }],
  },
  after: {
    source,
    content: "after\n",
    lines: [{ lineNumber: 1, content: "after", lineEnding: "\n" }],
  },
};

test.each([
  { effect: "unknown", observed: false, path: "" },
  { effect: "unknown", observed: true, path: source },
  { effect: "applied", observed: true, path: source },
] as const)("keeps $effect execution effects with observed=$observed", (fixture) => {
  const outcome = mutationOutcome(
    {
      content: [],
      isError: true,
      details: {
        effect: fixture.effect,
        results: [
          new FileMutationResult({
            ok: false,
            path: fixture.path,
            errors: [{ path: fixture.path, code: "EXECUTION_FAILED", reason: "fixture failed" }],
          }),
        ],
      },
    },
    "write",
    fixture.observed ? [completion] : [],
  );
  expect(outcome.status).toBe("error");
  expect(outcome.data?.effect).toBe(fixture.effect);
  expect(outcome.data?.files).toEqual(
    fixture.observed ? [{ source, effect: "applied", state: "present" }] : [],
  );
});

test("keeps restored and uncertain rollback resources beside confirmed applied peers", () => {
  const restored = "/workspace/source.txt";
  const failed = "/workspace/target.txt";
  const outcome = mutationOutcome(
    {
      content: [],
      isError: true,
      details: {
        effect: "unknown",
        results: [
          new FileMutationResult({
            ok: false,
            path: failed,
            errors: [{ path: failed, code: "WRITE_FAILED", reason: "write rejected" }],
            rollback: { failedSources: [failed], restoredSources: [restored] },
          }),
        ],
      },
    },
    "move",
    [completion],
  );
  expect(outcome.status).toBe("partial");
  expect(outcome.data).toEqual({
    operation: "move",
    effect: "unknown",
    files: [
      { source: failed, effect: "unknown" },
      { source: restored, effect: "not-applied" },
      { source, effect: "applied", state: "present" },
    ],
  });
});

test.each(["not-applied", "unknown"] as const)(
  "structured Write errors retain only closed retry metadata with %s effects",
  (effect) => {
    const privateDiagnostic = "private-write-metadata";
    const offered = {
      rateLimit: { retryAfterMs: 37000, authorization: privateDiagnostic },
      headers: privateDiagnostic,
    };
    const outcome = mutationOutcome(
      {
        content: [],
        isError: true,
        details: {
          effect,
          results: [
            new FileMutationResult({
              ok: false,
              path: source,
              errors: [
                { path: source, code: "RATE_LIMITED", reason: "Rate limited", metadata: offered },
              ],
            }),
          ],
        },
      },
      "write",
    );
    expect(outcome.errors).toEqual([
      {
        code: "RATE_LIMITED",
        message: "Rate limited",
        source,
        metadata: { rateLimit: { retryAfterMs: 37000 } },
      },
    ]);
    expect(outcome.data?.effect).toBe(effect);
    offered.rateLimit.retryAfterMs = 1;
    expect(outcome.errors[0]?.metadata?.rateLimit?.retryAfterMs).toBe(37000);
    expect(Object.isFrozen(outcome.errors[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(outcome.errors[0]?.metadata?.rateLimit)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(privateDiagnostic);
  },
);

test.each(["getter", "inherited"] as const)(
  "structured Write errors ignore %s metadata without changing their effect",
  (kind) => {
    let reads = 0;
    const error = { path: source, code: "RATE_LIMITED", reason: "Rate limited" };
    if (kind === "getter")
      Object.defineProperty(error, "metadata", {
        get() {
          reads++;
          throw new Error("private-write-metadata");
        },
      });
    else Object.setPrototypeOf(error, { metadata: { rateLimit: { retryAfterMs: 37000 } } });
    const outcome = mutationOutcome(
      {
        content: [],
        isError: true,
        details: {
          effect: "unknown",
          results: [
            new FileMutationResult({
              ok: false,
              path: source,
              errors: [error],
            }),
          ],
        },
      },
      "write",
    );
    expect(reads).toBe(0);
    expect(outcome.errors).toEqual([{ code: "RATE_LIMITED", message: "Rate limited", source }]);
    expect(outcome.data?.effect).toBe("unknown");
  },
);
