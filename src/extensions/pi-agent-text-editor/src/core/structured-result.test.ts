import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { mutationOutcome, mutationOutputSchema } from "./structured-result.js";

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
