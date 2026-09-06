import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CandidateEvidence } from "./release-candidate.ts";

function run(command: string, args: string[], cwd = process.cwd()): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error("Missing GitHub event");
const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
  pull_request?: { number: number; head: { sha: string; repo: { full_name: string } } };
};
const pr = event.pull_request;
if (!pr || pr.head.repo.full_name !== process.env.GITHUB_REPOSITORY)
  throw new Error("Expected a same-repository PR");
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const directory = ".agents/tmp/release-candidate";
mkdirSync(directory, { recursive: true });
run("pnpm", ["package:public"]);
const filename = `pi-agent-ide-${version}.tgz`;
const source = `.agents/tmp/public-package/${filename}`;
const first = readFileSync(source);
run("pnpm", ["package:public"]);
const second = readFileSync(source);
if (!first.equals(second)) throw new Error("Release archive is not reproducible");
run("pnpm", ["security:scan", "--", "artifact", source]);
cpSync(source, `${directory}/${filename}`);
for (const report of readdirSync(".agents/tmp/test-results")) {
  if (report.endsWith(".xml"))
    cpSync(`.agents/tmp/test-results/${report}`, `${directory}/${report}`);
}
const smoke = path.resolve(".agents/tmp/candidate-install");
mkdirSync(smoke, { recursive: true });
writeFileSync(path.join(smoke, "package.json"), JSON.stringify({ private: true, type: "module" }));
run("npm", ["install", path.resolve(source), "--registry=https://registry.npmjs.org/"], smoke);
run(
  "node",
  [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    "await import('./node_modules/pi-agent-ide/src/pi-agent-ide.ts')",
  ],
  smoke,
);
const evidence: CandidateEvidence = {
  version,
  repository: pr.head.repo.full_name,
  pullRequest: pr.number,
  headCommit: pr.head.sha,
  baseCommit: git("rev-parse", "HEAD^1"),
  tree: git("rev-parse", "HEAD^{tree}"),
  runId: Number(process.env.GITHUB_RUN_ID),
  sha256: createHash("sha256").update(second).digest("hex"),
  sha512: createHash("sha512").update(second).digest("hex"),
};
writeFileSync(`${directory}/candidate.json`, JSON.stringify(evidence, null, 2) + "\n");
