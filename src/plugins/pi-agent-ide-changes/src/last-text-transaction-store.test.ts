import { expect, test } from "vitest";
import { createTextDocument } from "pi-agent-text";
import { LastTextTransactionStore } from "./last-text-transaction-store.js";

const completion = (before: string, after: string, postProcessing: "deferred" | "final") => ({
  source: "/workspace/file.ts",
  resourceSource: "/workspace/file.ts",
  cwd: "/workspace",
  resolvedBy: "filesystem",
  existed: true,
  intent: "edit" as const,
  before: createTextDocument("/workspace/file.ts", before),
  after: createTextDocument("/workspace/file.ts", after),
  postProcessing,
});

test("final formatting updates undo's digest without replacing its pre-edit state", () => {
  const store = new LastTextTransactionStore();
  store.observe(completion("original", "first", "deferred"));
  store.observe(completion("first", "last", "deferred"));
  store.observe(completion("last", "LAST", "final"));
  expect(store.restore("/workspace/file.ts", "/workspace", "LAST")).toBe("first");
});

test("finalization cannot bless an unrelated newer transaction", () => {
  const store = new LastTextTransactionStore();
  store.observe(completion("before", "newer", "deferred"));
  store.observe(completion("older", "OLDER", "final"));
  expect(() => store.restore("/workspace/file.ts", "/workspace", "OLDER")).toThrow(Error);
});
