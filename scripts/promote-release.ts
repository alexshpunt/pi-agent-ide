import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  verifyCandidate,
  verifyCandidateArchive,
  type CandidateEvidence,
} from "./release-candidate.ts";

const repository = "alexshpunt/pi-agent-ide";
const pr = Number(process.env.RELEASE_PR);
const runId = Number(process.env.CANDIDATE_RUN);
if (!Number.isSafeInteger(pr) || pr <= 0 || !Number.isSafeInteger(runId) || runId <= 0) {
  throw new Error("A merged PR and successful candidate run are required");
}
function api(route: string): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${route}`], { encoding: "utf8" }),
  ) as unknown;
}
const pull = api(`pulls/${pr}`) as {
  merged: boolean;
  base: { ref: string };
  head: { sha: string; repo: { full_name: string } | null };
  merge_commit_sha: string;
};
const run = api(`actions/runs/${runId}`) as {
  conclusion: string;
  event: string;
  workflow_id: number;
  head_sha: string;
  head_repository: { full_name: string } | null;
};
const workflow = api("actions/workflows/ci.yml") as { id: number };
if (!pull.merged || pull.base.ref !== "main" || pull.head.repo?.full_name !== repository) {
  throw new Error("Only a merged same-repository main PR can be promoted");
}
if (
  run.conclusion !== "success" ||
  run.event !== "pull_request" ||
  run.workflow_id !== workflow.id ||
  run.head_sha !== pull.head.sha ||
  run.head_repository?.full_name !== repository
) {
  throw new Error("Candidate run is not successful CI for this PR head");
}
const commit = api(`git/commits/${pull.merge_commit_sha}`) as {
  tree: { sha: string };
  parents: { sha: string }[];
};
const main = api("git/ref/heads/main") as { object: { sha: string } };
if (main.object.sha !== pull.merge_commit_sha)
  throw new Error("Release must still be the current main commit");
const manifestResponse = api(`contents/package.json?ref=${pull.merge_commit_sha}`) as {
  content: string;
};
const manifest = JSON.parse(Buffer.from(manifestResponse.content, "base64").toString("utf8")) as {
  version: string;
};
const directory = ".agents/tmp/promoted-release";
mkdirSync(directory, { recursive: true });
execFileSync(
  "gh",
  [
    "run",
    "download",
    String(runId),
    "--repo",
    repository,
    "--name",
    "release-candidate",
    "--dir",
    directory,
  ],
  { stdio: "inherit" },
);
const evidence = JSON.parse(
  readFileSync(`${directory}/candidate.json`, "utf8"),
) as CandidateEvidence;
verifyCandidate(evidence, {
  repository,
  pullRequest: pr,
  runId,
  headCommit: pull.head.sha,
  version: manifest.version,
  tree: commit.tree.sha,
  parents: commit.parents.map((parent: { sha: string }) => parent.sha),
});
verifyCandidateArchive(directory, evidence);
writeFileSync(
  `${directory}/promotion.json`,
  JSON.stringify({ commit: pull.merge_commit_sha, runId, pr, version: evidence.version }) + "\n",
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${evidence.version}\ncommit=${pull.merge_commit_sha}\n`,
  );
