import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { activeReleaseBranches, canMergeIntoMain, isDevelopCommit } from "./merge-policy.ts";

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
describe("promotion head", () => {
  it("tells a commit of develop from a commit that only builds on it", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "promotion-head-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "first");
      git("commit", "-q", "--allow-empty", "-m", "second");
      const tip = git("rev-parse", "HEAD");
      const older = git("rev-parse", "HEAD~1");
      git("update-ref", "refs/remotes/origin/develop", tip);
      git("commit", "-q", "--allow-empty", "-m", "Promote the cut");
      const own = git("rev-parse", "HEAD");
      // The tip and an older commit were pushed to develop, so each has a push run there.
      expect(isDevelopCommit(tip, { cwd })).toBe(true);
      expect(isDevelopCommit(older, { cwd })).toBe(true);
      expect(isDevelopCommit(own, { cwd })).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
