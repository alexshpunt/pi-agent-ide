import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { mutationOutcome, mutationOutputSchema } from "./structured-result.js";

test("keeps a pending mutation target separate from its unapplied effect", () => {
  const result = {
    content: [],
    details: {
      results: [],
      source: "note.txt",
      nativeEditBatch: { state: "accepted", parentToolCallId: "script" },
      metadata: { resultTarget: "RESULT#pending" },
    },
  };
  const outcome = mutationOutcome(result, "replace");
  expect(outcome).toMatchObject({
    status: "success",
    data: { effect: "pending", target: "RESULT#pending" },
  });
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});

test("an unavailable target does not turn a completed write into a failure", () => {
  const result = semanticResult({ ok: true, source: "note.txt" });
  const outcome = mutationOutcome(
    {
      ...result,
      details: {
        ...result.details,
        metadata: { ...result.details.metadata, targetUnavailable: "Mapping changed" },
      },
    },
    "replace",
  );
  expect(outcome).toMatchObject({
    status: "success",
    data: { effect: "applied", targetUnavailable: "Mapping changed" },
  });
  expect(outcome.data?.target).toBeUndefined();
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});
function semanticResult(action: Record<string, unknown>) {
  return { content: [], details: { results: undefined, metadata: { semanticAction: action } } };
}

test("whole-file copy reports the source as unchanged and the target as applied", () => {
  const outcome = mutationOutcome(
    semanticResult({ ok: true, source: "source.txt", target: "target.txt" }),
    "copy",
  );
  expect(outcome).toMatchObject({
    status: "success",
    data: {
      effect: "applied",
      files: [
        { source: "source.txt", effect: "not-applied" },
        { source: "target.txt", effect: "applied" },
      ],
    },
  });
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});

test("transaction undo reports restored files rather than treating the receipt as a file", () => {
  const outcome = mutationOutcome(
    semanticResult({ ok: true, source: "APPLY#0123456789AB", restored: ["note.txt"] }),
    "undo",
  );
  expect(outcome).toMatchObject({
    status: "success",
    data: { effect: "applied", files: [{ source: "note.txt", effect: "applied" }] },
  });
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});

test("a failed copy is an error, not partial success from its unchanged source", () => {
  const outcome = mutationOutcome(
    semanticResult({
      ok: false,
      source: "source.txt",
      target: "target.txt",
      effect: "not-applied",
      error: { code: "TARGET_EXISTS", message: "Target already exists" },
    }),
    "copy",
  );
  expect(outcome).toMatchObject({ status: "error", data: { effect: "not-applied" } });
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});
