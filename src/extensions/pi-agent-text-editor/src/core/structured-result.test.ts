import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { mutationOutcome, mutationResultSchema, structuredMutation } from "./structured-result.js";
import { FileMutationResult } from "./mutation-result/file-mutation-result.js";

function semanticResult(action: Record<string, unknown>) {
  return { content: [], details: { results: undefined, metadata: { semanticAction: action } } };
}

test("each file tool validates only its own result fields", () => {
  for (const operation of ["write", "replace", "insert", "delete", "copy", "move", "undo"]) {
    const schema = mutationResultSchema(operation);
    const outcome = mutationOutcome(semanticResult({ ok: true, source: "note.txt" }), operation);
    expect(Value.Check(schema, outcome)).toBe(true);
    for (const field of ["action", "changes", "recovery", "operations", "parentToolCallId"]) {
      expect(Value.Check(schema, { ...outcome, data: { ...outcome.data, [field]: [] } })).toBe(
        false,
      );
    }
    expect(Value.Check(schema, { ...outcome, data: { ...outcome.data, operation: "other" } })).toBe(
      false,
    );
    if (operation === "delete")
      expect(
        Value.Check(schema, { ...outcome, data: { ...outcome.data, target: "RESULT#invalid" } }),
      ).toBe(false);
  }
});

test("keeps a pending mutation target separate from its unapplied effect", () => {
  const pending = {
    content: [],
    details: {
      results: [],
      nativeEditBatch: { state: "accepted", parentToolCallId: "script" },
      metadata: { resultTarget: "RESULT#pending" },
    },
  };
  const outcome = mutationOutcome(pending, "replace");
  expect(outcome).toMatchObject({
    status: "success",
    data: { effect: "pending", target: "RESULT#pending" },
  });
  expect(Value.Check(mutationResultSchema("replace"), outcome)).toBe(true);
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
  expect(Value.Check(mutationResultSchema("replace"), outcome)).toBe(true);
});

test("large removed contents stay in the owning edit record, not the result contract", () => {
  const removedText = "界".repeat(400_000);
  const result = structuredMutation(
    {
      content: [],
      details: {
        results: [
          new FileMutationResult({
            ok: true,
            path: "note.txt",
            files: [{ path: "note.txt", action: "edited" }],
            rawChanges: [
              {
                editIndex: 0,
                fromA: 0,
                toA: removedText.length,
                fromB: 0,
                toB: 0,
                removedText,
                insertedText: "",
              },
            ],
          }),
        ],
      },
    },
    "delete",
  );
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toMatchObject({
    status: "success",
    data: { effect: "applied" },
  });
  expect(result.structuredContent).not.toHaveProperty("data.changes");
  expect(result.details.results?.[0]?.data.rawChanges?.[0]?.removedText).toBe(removedText);
});

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
  expect(Value.Check(mutationResultSchema("copy"), outcome)).toBe(true);
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
  expect(Value.Check(mutationResultSchema("copy"), outcome)).toBe(true);
});
