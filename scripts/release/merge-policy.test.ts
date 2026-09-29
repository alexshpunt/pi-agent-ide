import { describe, expect, it } from "vitest";

import { activeReleaseBranches, canMergeIntoMain } from "./merge-policy.ts";

describe("release freeze", () => {
  it("keeps legacy branches without treating them as active releases", () => {
    const refs = [
      "abc123\trefs/heads/release/v0.6.3",
      "def456\trefs/heads/release/official-35373041178",
    ].join("\n");
    expect(activeReleaseBranches(refs)).toEqual([]);
    expect(activeReleaseBranches(`${refs}\n012345\trefs/heads/release/0.6.4`)).toEqual([
      "release/0.6.4",
    ]);
  });
  it("allows normal merges outside a release", () => {
    expect(canMergeIntoMain([], "develop", [])).toBe(true);
  });

  it("blocks ordinary develop and unlabeled changes while a release is active", () => {
    expect(canMergeIntoMain(["release/0.7.0"], "develop", [])).toBe(false);
    expect(canMergeIntoMain(["release/0.7.0"], "fix/release-crash", [])).toBe(false);
    expect(canMergeIntoMain(["release/0.7.0"], "feature/abc", ["release-fix"])).toBe(false);
  });

  it("allows only the release candidate or labeled release fixes", () => {
    expect(canMergeIntoMain(["release/0.7.0"], "release/0.7.0", [])).toBe(true);
    expect(canMergeIntoMain(["release/0.7.0"], "fix/release-crash", ["release-fix"])).toBe(true);
  });

  it("fails closed for concurrent releases", () => {
    expect(canMergeIntoMain(["release/0.7.0", "release/0.8.0"], "release/0.7.0", [])).toBe(false);
  });
});
