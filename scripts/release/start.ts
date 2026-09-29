import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { activeReleaseBranches } from "./merge-policy.ts";

const version = process.env.RELEASE_VERSION;
const notes = process.env.RELEASE_NOTES?.trim();
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !notes) {
  throw new Error("A stable X.Y.Z version and release notes are required");
}
if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Start releases from main only");
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
const active = git("ls-remote", "origin", "refs/heads/release/*");
if (activeReleaseBranches(active).length)
  throw new Error("Finish or explicitly cancel the existing release before starting another");
if (git("tag", "--list", `v${version}`)) throw new Error("Version tag already exists");
const registry = await fetch(`https://registry.npmjs.org/pi-agent-ide/${version}`);
if (registry.status !== 404)
  throw new Error(`Version already exists or registry unavailable: ${registry.status}`);
const branch = `release/${version}`;
execFileSync("git", ["switch", "--create", branch], { stdio: "inherit" });
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
manifest.version = version;
writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = `## ${version} — ${new Date().toISOString().slice(0, 10)}`;
if (changelog.includes(`## ${version} —`)) throw new Error("Changelog already has this version");
writeFileSync(
  "CHANGELOG.md",
  changelog.replace("# Changelog\n", `# Changelog\n\n${heading}\n\n${notes}\n`),
);
execFileSync("pnpm", ["install", "--lockfile-only"], { stdio: "inherit" });
execFileSync("git", ["add", "package.json", "pnpm-lock.yaml", "CHANGELOG.md"], {
  stdio: "inherit",
});
execFileSync("git", ["commit", "--message", `chore: prepare ${version} release`], {
  stdio: "inherit",
});
execFileSync("git", ["push", "origin", branch], { stdio: "inherit" });
execFileSync(
  "gh",
  [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    `Release ${version}`,
    "--body",
    `Validate pi-agent-ide@${version} before publication.`,
  ],
  { stdio: "inherit" },
);
