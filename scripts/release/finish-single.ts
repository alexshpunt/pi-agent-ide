import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { verifyCandidateArchive, type CandidateEvidence } from "#scripts/release-candidate.ts";

const directory = ".agents/tmp/promoted-release";
const evidence = JSON.parse(
  readFileSync(`${directory}/candidate.json`, "utf8"),
) as CandidateEvidence;
const version = process.env.RELEASE_VERSION;
if (version !== evidence.version || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Finish requires the verified release version on main");
}
const archive = verifyCandidateArchive(directory, evidence);
const registry = await fetch(`https://registry.npmjs.org/pi-agent-ide/${version}`);
if (!registry.ok) throw new Error("Package has not been published; main remains frozen");
const published = (await registry.json()) as { dist?: { integrity?: string } };
if (
  published.dist?.integrity !== `sha512-${Buffer.from(evidence.sha512, "hex").toString("base64")}`
) {
  throw new Error("Registry archive differs from the verified release candidate");
}
if (!archive) throw new Error("Missing verified archive");
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
const branch = `refs/heads/release/${version}`;
const branchHead = git("ls-remote", "origin", branch).split("\t")[0];
if (branchHead !== evidence.headCommit) {
  throw new Error("Release branch changed after candidate validation; do not lift the freeze");
}
execFileSync("git", ["fetch", "origin", "main", "develop"], { stdio: "inherit" });
execFileSync("git", ["switch", "--create", "finish-release", "origin/develop"], {
  stdio: "inherit",
});
execFileSync("git", ["merge", "--no-ff", "--no-edit", "origin/main"], { stdio: "inherit" });
execFileSync("git", ["push", "origin", "HEAD:develop"], { stdio: "inherit" });
execFileSync(
  "git",
  ["push", `--force-with-lease=${branch}:${branchHead}`, "origin", `:${branch}`],
  {
    stdio: "inherit",
  },
);
