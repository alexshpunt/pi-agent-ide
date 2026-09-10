import { requiredValue } from "pi-agent-invariant";
import { expect, test } from "vitest";
import { FileMutationResult } from "#src/api/mutation-result.js";
import { ApplyResults } from "#src/core/apply/results.js";
import { finalApplyMutations } from "#src/core/apply/final-mutations.js";

test("net presentation retains execution order and latest file annotations", () => {
  const results = new ApplyResults();
  for (const [id, before, after] of [
    ["first", "old", "middle"],
    ["second", "middle", "final"],
  ] as const) {
    results.record(id, "mutation", {
      operation: id === "first" ? "write" : "replace",
      effect: "applied",
      files: [
        { source: "note.txt", before, after, changes: [], formatting: { status: "unchanged" } },
      ],
    });
    results.updateFile("note.txt", before, after);
  }
  results.addOperation("first");
  results.rememberMutation(
    "note.txt",
    new FileMutationResult({
      ok: true,
      afterContent: "final",
      resultPresentation: "major-anchor",
      diffStatuses: [{ text: "formatted", tone: "success" }],
    }),
  );
  const file = requiredValue(finalApplyMutations(results)[0]);
  expect(file.data.snapshot?.content).toBe("old");
  expect(file.afterContent).toBe("final");
  expect(file.data.operations?.map(({ operation }) => operation)).toEqual(["write", "replace"]);
  expect(file.data.resultPresentation).toBe("major-anchor");
  expect(file.data.diffStatuses).toEqual([{ text: "formatted", tone: "success" }]);
  results.updateFile("note.txt", "final", "later");
  expect(requiredValue(finalApplyMutations(results)[0]).data.resultPresentation).toBeUndefined();
});
