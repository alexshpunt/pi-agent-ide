import { describe, expect, test } from "vitest";

import { batchOperations, CodemodeCallLedger, fileEffects, formatFailures } from "./failures.ts";

describe("CodemodeCallLedger", () => {
  test("counts every call and lists only the failed ones", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "read", source: "a.txt" });
    ledger.record(
      "script",
      { id: "2", tool: "read", source: "missing.txt" },
      { reason: "Unable to read missing.txt\nSearch for the correct path." },
    );
    ledger.record("script", { id: "3", tool: "read", source: "c.txt" });

    expect(ledger.take("script")).toBe(
      "1 of 3 IDE calls failed:\n- read missing.txt\n  Unable to read missing.txt\n  Search for the correct path.",
    );
    expect(ledger.take("script")).toBeUndefined();
  });

  test("has no block for a script whose calls all succeeded", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "search" });
    expect(ledger.take("script")).toBeUndefined();
  });

  test("adds accepted edits whose batch failed, with the files of the batch", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "replace", source: "a.txt" });
    ledger.record("script", { id: "2", tool: "replace", source: "b.txt" });
    ledger.recordBatch("script", [
      { id: "1", effect: "unknown", errors: [{ message: "Disk full" }], changed: ["b.txt"] },
      { id: "2", effect: "applied", errors: [] },
    ]);

    expect(ledger.take("script")).toBe(
      [
        "1 of 2 IDE calls failed:",
        "- replace a.txt",
        "  Changed: b.txt. Do not repeat this edit blindly; Read the files first.",
        "  The edit was accepted, then its editor batch failed when it was saved; the files above are those of the whole batch.",
        "  Disk full",
      ].join("\n"),
    );
  });

  test("does not list an unchanged batched edit or one already listed as failed", () => {
    const ledger = new CodemodeCallLedger();
    ledger.record("script", { id: "1", tool: "replace" }, { reason: "Anchor not found" });
    ledger.record("script", { id: "2", tool: "replace" });
    ledger.recordBatch("script", [
      { id: "1", effect: "not-applied", errors: [{ message: "Not run" }] },
      { id: "2", effect: "not-applied", errors: [] },
    ]);

    expect(ledger.take("script")).toBe("1 of 2 IDE calls failed:\n- replace\n  Anchor not found");
  });
});

test("formatFailures names changed and unknown files of a failed edit", () => {
  expect(
    formatFailures(300, [
      { tool: "move", source: "a.txt → b.txt", reason: "Copy failed", changed: ["b.txt"] },
      { tool: "write", reason: "Connection lost", unknown: ["c.txt"] },
    ]),
  ).toBe(
    [
      "2 of 300 IDE calls failed:",
      "- move a.txt → b.txt",
      "  Changed: b.txt. Do not repeat this edit blindly; Read the files first.",
      "  Copy failed",
      "- write",
      "  Effect unknown: c.txt. Do not repeat this edit blindly; Read the files first.",
      "  Connection lost",
    ].join("\n"),
  );
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

test("batchOperations reads the operations of every batch receipt", () => {
  const details = {
    editorBatchResults: [
      {
        status: "partial",
        data: {
          files: [{ source: "a.txt", effect: "applied" }],
          operations: [
            { id: "1", operation: "replace", effect: "applied", errors: [{ message: "Late" }] },
          ],
        },
      },
      { status: "success", data: { files: [], operations: [{ id: "2", effect: "applied" }] } },
    ],
  };
  expect(batchOperations(details)).toEqual([
    { id: "1", effect: "applied", errors: [{ message: "Late" }], changed: ["a.txt"] },
  ]);
  expect(batchOperations({})).toEqual([]);
});
