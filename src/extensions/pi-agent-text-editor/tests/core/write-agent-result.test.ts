import { expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { FileMutationResult, type FileMutationBatchResult } from "#src/api/mutation-result.js";
import { writeAgentResult, writeProblemNotices } from "#src/core/write-agent-result.js";

test.each(["applied", "not-applied", "unknown"] as const)(
  "semantic Write retains its %s action receipt without file completions",
  (effect) => {
    const result: AgentToolResult<FileMutationBatchResult> = {
      content: [
        {
          type: "text",
          text: `Resource effect: ${effect}; attempted prefix retained. Never replay unknown effects.`,
        },
      ],
      details: {
        results: [],
        metadata: {
          semanticAction: {
            source: "fixture:action",
            kind: "fixture-action",
            ok: effect === "applied",
            effect,
            receipt: { attempted: 2, completed: effect === "applied" ? 2 : 1 },
          },
        },
      },
    };
    expect(writeAgentResult(result, [], "fixture:action")).toBe(result);
  },
);

test("file Write without a completion still returns a compact uncertain receipt", () => {
  const result: AgentToolResult<FileMutationBatchResult> = {
    content: [{ type: "text", text: "Full file mutation details" }],
    details: { results: [new FileMutationResult({ ok: true, path: "fixture.txt" })] },
  };
  const receipt = writeAgentResult(result, [], "fixture.txt");
  expect(receipt).not.toBe(result);
  expect(receipt.content).toEqual([
    {
      type: "text",
      text: "Write outcome unknown.\nPath: fixture.txt\nRead the file if you need its content.",
    },
  ]);
  expect(receipt.details).toBe(result.details);
});

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
