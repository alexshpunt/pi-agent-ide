import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Ignore legacy release refs when finding active versioned releases. */
export function activeReleaseBranches(refs: string): string[] {
  return refs
    .split("\n")
    .map((line) => line.split("refs/heads/")[1])
    .filter((name): name is string => name !== undefined && /^release\/\d+\.\d+\.\d+$/.test(name));
}
/** Check which pull requests may enter main while a release branch exists. */
export function canMergeIntoMain(
  releaseBranches: readonly string[],
  head: string,
  labels: readonly string[],
): boolean {
  if (releaseBranches.length === 0) return true;
  if (releaseBranches.length !== 1) return false;
  return (
    head === releaseBranches[0] ||
    (head.startsWith("fix/release-") && labels.includes("release-fix"))
  );
}

/**
 * Whether `sha` is a commit of develop, which `origin/develop` must already hold. Such a commit has
 * a push run on develop that the next develop push cancels, and a cancelled required `Validate`
 * check on it blocks a merge even when the pull request run passed.
 */
export function isDevelopCommit(
  sha: string,
  options: { cwd?: string; ref?: string } = {},
): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, options.ref ?? "origin/develop"], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    // Exit status 1 means "not an ancestor"; any other failure is a real error.
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const head = process.env.PR_HEAD;
  if (!repository || !head) throw new Error("Missing repository or PR head");
  const headSha = process.env.PR_HEAD_SHA;
  if (headSha && isDevelopCommit(headSha)) {
    throw new Error(
      `The head of a pull request into main is ${headSha}, a commit of develop. Promote a cut ` +
        "through its own commit: push the cut plus `git commit --allow-empty`, not the cut itself.",
    );
  }
  const refs = execFileSync("git", ["ls-remote", "origin", "refs/heads/release/*"], {
    encoding: "utf8",
  });
  const labels = JSON.parse(process.env.PR_LABELS ?? "[]") as string[];
  const active = activeReleaseBranches(refs);
  if (!canMergeIntoMain(active, head, labels)) {
    throw new Error(
      `main is frozen by ${active.join(", ")}; only its release PR or labeled release fixes may merge`,
    );
  }
}
