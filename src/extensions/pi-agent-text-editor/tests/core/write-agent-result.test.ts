import { expect, test } from "vitest";
import { FileMutationResult } from "#src/api/mutation-result.js";
import { writeProblemNotices } from "#src/core/write-agent-result.js";

// A completion-hook remark is not proof that post-edit processing was interrupted.
test.each(["muted", "warning", "error"] as const)(
  "compact Write preserves %s hook feedback without claiming interruption",
  (tone) => {
    const result = new FileMutationResult({
      ok: true,
      diffStatuses: [
        { text: "Review the saved change", tone, origin: "after-edit" },
        { text: "Extra check finished", tone: "success" },
      ],
    });
    expect(writeProblemNotices([result])).toEqual(["Review the saved change"]);
  },
);

test("hook feedback does not hide an independent recovery or formatting problem", () => {
  const result = new FileMutationResult({
    ok: true,
    formatting: { status: "failed", formatter: "fixture" },
    diffStatuses: [
      { text: "Fixture recovery detail", tone: "warning" },
      { text: "Review the saved change", tone: "warning", origin: "after-edit" },
    ],
  });
  expect(writeProblemNotices([result])).toEqual([
    "Formatting failed.",
    "Post-edit processing was interrupted or incomplete.",
    "Review the saved change",
  ]);
});
