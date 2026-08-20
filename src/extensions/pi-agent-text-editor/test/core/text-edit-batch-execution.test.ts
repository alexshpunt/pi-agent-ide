import { describe, expect, it } from "vitest";

import { BatchExecutionJournal } from "#src/core/text-edit-batch-execution.js";

const result = { content: [{ type: "text" as const, text: "ok" }], details: {} };

describe("BatchExecutionJournal", () => {
  it("records completion and preserves the result", () => {
    const journal = new BatchExecutionJournal(["first", "second"]);
    const reporter = journal.reporter();

    reporter.start("first");
    reporter.complete("first", result);

    expect(journal.snapshot()).toEqual([
      { callId: "first", state: "completed", result, recovered: false },
      { callId: "second", state: "pending", recovered: false },
    ]);
  });

  it("marks a running call unknown after an unclassified exception", () => {
    const journal = new BatchExecutionJournal(["call"]);
    const error = new Error("write boundary failed");

    journal.reporter().start("call");
    journal.markRunningUnknown(error);

    expect(journal.get("call")).toMatchObject({
      state: "failed-unknown",
      failure: { error, effect: "unknown" },
    });
  });

  it("keeps blocked calls and recovered transitions distinct", () => {
    const journal = new BatchExecutionJournal(["blocked", "recovered"]);
    journal.block("blocked", result, { guardId: "stale-anchor" });
    journal.reporter(true).start("recovered");
    journal.reporter(true).complete("recovered", result);

    expect(journal.get("blocked")).toMatchObject({ state: "blocked", recovered: false });
    expect(journal.get("recovered")).toMatchObject({ state: "completed", recovered: true });
  });
});
