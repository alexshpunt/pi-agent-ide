import { describe, expect, test } from "vitest";

import { batchOperations, CodemodeCallLedger, fileEffects, formatFailures } from "./failures.ts";

describe("CodemodeCallLedger", () => {
  test("counts every call and lists only the failed ones", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "read", source: "a.txt" });
    ledger.record(
      "script",
      { id: "2", tool: "read", source: "missing.txt" },
      { reason: "fixture-read-failure" },
    );
    ledger.record("script", { id: "3", tool: "read", source: "c.txt" });

    const summary = ledger.take("script");
    expect(summary).toMatch(/\b1\b/u);
    expect(summary).toMatch(/\b3\b/u);
    expect(summary).toContain("missing.txt");
    expect(summary).toContain("fixture-read-failure");
    expect(summary).not.toContain("a.txt");
    expect(summary).not.toContain("c.txt");
    expect(ledger.take("script")).toBeUndefined();
  });

  test("has no block for a script whose calls all succeeded", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "search" });
    expect(ledger.take("script")).toBeUndefined();
  });

  test("adds accepted edits whose batch failed, with the files of each edit", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "replace", source: "accepted.txt" });
    ledger.record("script", { id: "2", tool: "replace", source: "successful.txt" });
    ledger.recordBatch("script", [
      {
        id: "1",
        effect: "unknown",
        errors: [{ message: "fixture-save-failure" }],
        changed: ["changed.txt"],
      },
      { id: "2", effect: "applied", errors: [] },
    ]);

    const summary = ledger.take("script");
    expect(summary).toContain("accepted.txt");
    expect(summary).toContain("changed.txt");
    expect(summary).toContain("fixture-save-failure");
    expect(summary).not.toContain("successful.txt");
  });

  test("does not list an unchanged batched edit or one already listed as failed", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record(
      "script",
      { id: "1", tool: "replace", source: "refused.txt" },
      { reason: "fixture-refusal" },
    );
    ledger.record("script", { id: "2", tool: "replace", source: "unchanged.txt" });
    ledger.recordBatch("script", [
      { id: "1", effect: "not-applied", errors: [{ message: "fixture-batch-refusal" }] },
      { id: "2", effect: "not-applied", errors: [] },
    ]);

    const summary = ledger.take("script");
    expect(summary).toContain("fixture-refusal");
    expect(summary?.split("refused.txt")).toHaveLength(2);
    expect(summary).not.toContain("unchanged.txt");
    expect(summary).not.toContain("fixture-batch-refusal");
  });
});

test("formatFailures names changed and unknown files of a failed edit", () => {
  const summary = formatFailures(300, [
    {
      tool: "move",
      source: "a.txt → b.txt",
      reason: "fixture-copy-failure",
      changed: ["changed.txt"],
    },
    { tool: "write", reason: "fixture-connection-failure", unknown: ["unknown.txt"] },
  ]);
  expect(summary).toMatch(/\b2\b/u);
  expect(summary).toMatch(/\b300\b/u);
  for (const value of [
    "a.txt → b.txt",
    "changed.txt",
    "unknown.txt",
    "fixture-copy-failure",
    "fixture-connection-failure",
  ])
    expect(summary).toContain(value);
});

test("fileEffects reads applied and unknown files from an edit receipt", () => {
  const receipt = {
    status: "partial",
    data: {
      files: [
        { source: "/w/a.txt", effect: "applied" },
        { source: "/w/b.txt", effect: "not-applied" },
        { source: "/w/c.txt", effect: "unknown" },
      ],
    },
  };
  expect(fileEffects(receipt, (source) => source.replace("/w/", ""))).toEqual({
    changed: ["a.txt"],
    unknown: ["c.txt"],
  });
  expect(fileEffects({ status: "error", errors: [] })).toEqual({});
});

test("batchOperations reads each operation with its own files", () => {
  const details = {
    editorBatchResults: [
      {
        status: "partial",
        data: {
          files: [
            { source: "/w/a.txt", effect: "applied" },
            { source: "/w/b.txt", effect: "applied" },
          ],
          operations: [
            {
              id: "1",
              operation: "replace",
              effect: "unknown",
              errors: [{ message: "Late" }],
              files: [{ source: "/w/a.txt", effect: "applied" }],
            },
            {
              id: "2",
              operation: "replace",
              effect: "applied",
              errors: [],
              files: [{ source: "/w/b.txt", effect: "applied" }],
            },
          ],
        },
      },
      { status: "success", data: { files: [], operations: [{ id: "3", effect: "applied" }] } },
    ],
  };
  expect(batchOperations(details, (source) => source.replace("/w/", ""))).toEqual([
    { id: "1", effect: "unknown", errors: [{ message: "Late" }], changed: ["a.txt"] },
    { id: "2", effect: "applied", errors: [], changed: ["b.txt"] },
  ]);
  expect(batchOperations({})).toEqual([]);
});
