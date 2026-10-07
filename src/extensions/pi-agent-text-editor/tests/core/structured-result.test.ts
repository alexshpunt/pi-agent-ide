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
