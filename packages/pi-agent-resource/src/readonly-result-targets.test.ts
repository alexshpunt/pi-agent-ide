import { expect, test } from "vitest";
import { ResultTargetStore } from "./result-targets.ts";

const cwd = "/fixture";
const target = {
  source: "report:fixture",
  expectedContent: "finding\n",
  ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 7 } }],
};

test("read-only source restrictions survive derived selections but allow reading", () => {
  const store = new ResultTargetStore();
  const report = store.register([target], cwd, true, undefined, "Read the source file to edit it.");
  const derived = store.register(store.resolve(report, cwd).targets, cwd);
  // Search can register fresh matches against the same owning source.
  const match = store.register([{ ...target, ranges: target.ranges }], cwd);
  for (const reference of [report, derived, match]) {
    expect(store.resolve(reference, cwd).targets).toHaveLength(1);
    for (const options of [{ forEdit: true }, { forScope: true, allowAdjusted: true }])
      expect(() => store.resolve(reference, cwd, options)).toThrowError(
        expect.objectContaining({ code: "NO_EDITABLE_TEXT", effect: "not-applied" }),
      );
  }
  const elsewhere = store.register([target], "/other-worktree");
  expect(store.resolve(elsewhere, "/other-worktree", { forEdit: true }).targets).toHaveLength(1);
  store.clear();
  const afterClear = store.register([target], cwd);
  expect(store.resolve(afterClear, cwd, { forEdit: true }).targets).toHaveLength(1);
});

test("token warnings still permit an explicitly scoped edit", () => {
  const store = new ResultTargetStore();
  const reference = store.register([target], cwd, true, "Select one match.");
  expect(() => store.resolve(reference, cwd, { forEdit: true })).toThrowError(
    expect.objectContaining({ code: "UNSAFE_TOKEN_SELECTION" }),
  );
  expect(store.resolve(reference, cwd, { forScope: true }).targets).toHaveLength(1);
});
