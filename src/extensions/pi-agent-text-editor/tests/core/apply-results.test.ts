import { expect, test } from "vitest";
import { ApplyResults } from "#src/core/apply/results.js";

test("reports reads automatically until any mutation is attempted", () => {
  const results = new ApplyResults();
  results.record("read-1", "read", { lines: ["alpha"] });
  expect(results.select().automatic.map((entry) => entry.id)).toEqual(["read-1"]);
  results.record("replace-1", "mutation", { ok: false });
  expect(results.select().automatic.map((entry) => entry.id)).toEqual(["replace-1"]);
});

test("keeps explicit values and deduplicates an explicitly selected operation", () => {
  const results = new ApplyResults();
  results.record("read-1", "read", { lines: ["alpha"] });
  results.record("replace-1", "mutation", { ok: true });
  results.addOperation("read-1");
  results.addOperation("replace-1");
  results.addOperation("replace-1");
  results.addValue({ note: "done" });
  const selected = results.select();
  expect(selected.explicit).toEqual([
    { kind: "operation", id: "read-1", value: { lines: ["alpha"] } },
    { kind: "operation", id: "replace-1", value: { ok: true } },
    { kind: "value", value: { note: "done" } },
  ]);
  expect(selected.automatic).toEqual([]);
});

test("does not deduplicate separate calls with equal values", () => {
  const results = new ApplyResults();
  results.record("read-1", "read", { lines: ["alpha"] });
  results.record("read-2", "read", { lines: ["alpha"] });
  expect(results.select().automatic.map((entry) => entry.id)).toEqual(["read-1", "read-2"]);
});

test("consolidates final file state without losing initial state or errors", () => {
  const results = new ApplyResults();
  results.record("edit-1", "mutation", { ok: true });
  results.updateFile("fixture", "alpha", "beta");
  results.record("edit-2", "mutation", { ok: true });
  results.updateFile("fixture", "beta", "gamma");
  results.record("edit-3", "mutation", { ok: false, code: "STALE_ANCHOR" });
  expect(results.select().files).toEqual([{ source: "fixture", before: "alpha", after: "gamma" }]);
  expect(results.select().automatic).toHaveLength(3);
  results.updateFile("fixture", "gamma", "alpha");
  expect(results.select().files).toEqual([{ source: "fixture", before: "alpha", after: "alpha" }]);
});

test("rejects unknown identities rather than dropping output", () => {
  const results = new ApplyResults();
  expect(() => results.addOperation("missing")).toThrow(Error);
});
