import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = process.env.RELEASE_VERSION;
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || process.env.CONFIRM_CANCEL !== "cancel") {
  throw new Error("Explicit release version and cancel confirmation required");
}
if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Cancel releases from main only");
const registry = await fetch(`https://registry.npmjs.org/pi-agent-ide/${version}`);
if (registry.status !== 404) throw new Error("Published or registry unavailable; cannot cancel");
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
if (git("tag", "--list", `v${version}`)) throw new Error("Tagged releases cannot be canceled");
const branch = `refs/heads/release/${version}`;
const head = git("ls-remote", "origin", branch).split("\t")[0] ?? "";
if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("No active release branch");
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error("Missing repository");
const prs = JSON.parse(
  execFileSync(
    "gh",
    ["api", `repos/${repository}/pulls?state=all&head=alexshpunt:release/${version}`],
    {
      encoding: "utf8",
    },
  ),
) as { number: number; merged_at: string | null; state: string }[];
if (prs.some((pr) => pr.merged_at)) {
  const main = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  if (main.version === version) {
    throw new Error(
      "Revert the merged release PR on main and review the rollback before canceling",
    );
  }
}
for (const pr of prs.filter((pr) => pr.state === "open")) {
  execFileSync("gh", ["pr", "close", String(pr.number)], { stdio: "inherit" });
}
execFileSync("git", ["push", `--force-with-lease=${branch}:${head}`, "origin", `:${branch}`], {
  stdio: "inherit",
});
