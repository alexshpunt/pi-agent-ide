import { describe, expect, test } from "vitest";
import { ResultTargetStore, type ResultSourceTarget } from "./result-targets.js";

const target: ResultSourceTarget = {
  source: "/workspace/a.txt",
  expectedContent: "a b\n",
  ranges: [{ start: { lineNumber: 1, column: 2 }, end: { lineNumber: 1, column: 3 } }],
};

describe("source result targets", () => {
  test("keeps snapshot authority out of projected JSON and returned coordinates", () => {
    const store = new ResultTargetStore();
    const reference = store.register([target], "/workspace");
    const resolved = store.resolve(
      { target: reference, source: "/workspace/wrong.txt", ranges: [] },
      "/workspace",
    );
    expect(resolved.targets).toEqual([target]);
    Object.assign(resolved.targets[0]?.ranges[0]?.start ?? {}, { column: 0 });
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    expect(() =>
      store.resolve({ source: target.source, ranges: target.ranges }, "/workspace"),
    ).toThrow("no supported source target");
  });

  test("keeps incomplete source knowledge through subsets and duplicate targets", () => {
    const store = new ResultTargetStore();
    const reference = store.register([target], "/workspace", false);
    const resolved = store.resolve([{ target: reference }, { target: reference }], "/workspace");
    expect(resolved).toEqual({ targets: [target], complete: false });
    expect(store.resolve([], "/workspace")).toEqual({ targets: [], complete: true });
  });

  test("rejects conflicting snapshots, another worktree, and expired handles", () => {
    const store = new ResultTargetStore();
    const first = store.register([target], "/workspace");
    const second = store.register([{ ...target, expectedContent: "changed\n" }], "/workspace");
    expect(() => store.resolve([first, second], "/workspace")).toThrow("different snapshots");
    expect(() => store.resolve(first, "/other-worktree")).toThrow("another worktree");
    store.clear();
    expect(() => store.resolve(first, "/workspace")).toThrow("expired or unknown");
  });

  test("confirms pending handles once without rebinding committed snapshots", () => {
    const store = new ResultTargetStore();
    const reference = store.reserve("/workspace");
    expect(() => store.resolve(reference, "/workspace")).toThrow("pending");
    expect(() => store.confirm(reference, [target], "/other-worktree")).toThrow("this worktree");
    store.confirm(reference, [target], "/workspace");
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    expect(() =>
      store.confirm(reference, [{ ...target, expectedContent: "new" }], "/workspace"),
    ).toThrow("Only a pending result");
    store.reject(reference, "later failure");
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    const rejected = store.reserve("/workspace");
    store.reject(rejected, "Write was cancelled");
    expect(() => store.resolve(rejected, "/workspace")).toThrow("Write was cancelled");
    expect(() => store.confirm(rejected, [target], "/workspace")).toThrow("Only a pending result");
  });

  test("preserves zero-width positions as targets rather than an empty set", () => {
    const store = new ResultTargetStore();
    const position = {
      ...target,
      ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 0 } }],
    };
    const reference = store.register([position], "/workspace");
    expect(store.resolve(reference, "/workspace").targets).toEqual([position]);
  });
});
