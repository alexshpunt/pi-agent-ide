import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const head = process.env.PR_HEAD;
  if (!repository || !head) throw new Error("Missing repository or PR head");
  const refs = execFileSync("git", ["ls-remote", "origin", "refs/heads/release/*"], {
    encoding: "utf8",
  });
  const labels = JSON.parse(process.env.PR_LABELS ?? "[]") as string[];
  const active = refs
    .split("\n")
    .map((line) => line.split("refs/heads/")[1])
    .filter((name): name is string => name !== undefined && /^release\/\d+\.\d+\.\d+$/.test(name));
  if (!canMergeIntoMain(active, head, labels)) {
    throw new Error(
      `main is frozen by ${active.join(", ")}; only its release PR or labeled release fixes may merge`,
    );
  }
}
