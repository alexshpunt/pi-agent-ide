import { describe, expect, it } from "vitest";

import { canMergeIntoMain } from "./merge-policy.ts";

describe("release freeze", () => {
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
