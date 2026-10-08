import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { mutationOutcome, mutationOutputSchema } from "./structured-result.js";
import { FileMutationResult } from "#src/api/mutation-result.js";

test("saved hook feedback remains advisory in a structured whole-file receipt", () => {
  const outcome = mutationOutcome(
    semanticResult({
      ok: true,
      effect: "applied",
      source: "source.txt",
      target: "target.txt",
      diffStatuses: [{ text: "Review the saved café file", tone: "warning" }],
    }),
    "copy",
  );
  expect(outcome).toMatchObject({
    status: "success",
    errors: [],
    data: {
      effect: "applied",
      operations: [
        {
          operation: "copy",
          effect: "applied",
          status: "warning",
          errors: [],
          warnings: [
            {
              code: "POST_EDIT_FEEDBACK",
              message: "Review the saved café file",
              source: "target.txt",
            },
          ],
        },
      ],
    },
  });
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

test("undo reports restored absence without granting it a text target", () => {
  const outcome = mutationOutcome(
    semanticResult({
      ok: true,
      source: "APPLY#0123456789AB",
      restored: ["note.txt", "created.txt"],
      restoredStates: [
        { source: "note.txt", state: "present" },
        { source: "created.txt", state: "absent" },
      ],
    }),
    "undo",
  );
  expect(outcome).toMatchObject({
    status: "success",
    data: {
      effect: "applied",
      files: [
        { source: "note.txt", effect: "applied", state: "present" },
        { source: "created.txt", effect: "applied", state: "absent" },
      ],
    },
  });
  expect(outcome.data?.target).toBeUndefined();
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

test("an acknowledged restoration stays applied when its cleanup failed", () => {
  const outcome = mutationOutcome(
    semanticResult({
      kind: "direct-mutation",
      ok: false,
      effect: "applied",
      source: "APPLY#0123456789AB",
      restored: ["note.txt"],
      error: { code: "APPLY_UNDO_CLEANUP_FAILED", message: "Journal cleanup failed" },
    }),
    "undo",
  );
  expect(outcome).toMatchObject({
    status: "error",
    data: { effect: "applied", files: [{ source: "note.txt", effect: "applied" }] },
  });
  expect(outcome.errors).toEqual([
    {
      code: "APPLY_UNDO_CLEANUP_FAILED",
      message: "Journal cleanup failed",
      source: "APPLY#0123456789AB",
    },
  ]);
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});

test("cleanup adaptation lists real participants and one complete error", () => {
  const source = "APPLY#0123456789AB";
  const code = "APPLY_UNDO_CLEANUP_FAILED";
  const message = "Journal cleanup failed";
  const base = semanticResult({
    ok: false,
    effect: "applied",
    source,
    restored: ["note.txt"],
    error: { code, message },
  });
  const outcome = mutationOutcome(
    {
      ...base,
      details: {
        ...base.details,
        effect: "applied",
        results: [
          new FileMutationResult({
            ok: false,
            path: source,
            errors: [{ path: source, code, reason: message }],
          }),
        ],
      },
    },
    "undo",
  );
  expect(outcome.data?.files).toEqual([{ source: "note.txt", effect: "applied" }]);
  expect(outcome.errors).toEqual([{ code, message, source }]);
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});

test("confirmed text effects do not settle an unknown follow-up publication", () => {
  const outcome = mutationOutcome(
    {
      content: [],
      isError: true,
      details: {
        effect: "unknown",
        results: [
          new FileMutationResult({
            ok: true,
            path: "note.txt",
            files: [{ path: "note.txt", action: "edited" }],
            errors: [
              { path: "note.txt", code: "POST_WRITE_FAILED", reason: "Index acknowledgement lost" },
            ],
          }),
        ],
      },
    },
    "undo",
  );
  expect(outcome).toMatchObject({
    status: "error",
    data: {
      effect: "unknown",
      files: [{ source: "note.txt", effect: "applied" }],
    },
  });
  expect(Value.Check(mutationOutputSchema, outcome)).toBe(true);
});
