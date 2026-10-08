import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  decideCiRun,
  parseCiEvidence,
  type CiEvidence,
  type CiRequest,
  type EvidenceCandidate,
} from "./ci-evidence.ts";
import { lookupCiEvidence, type EvidenceBackend } from "./ci-evidence-lookup.ts";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Invalid GitHub object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid GitHub string");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw Error("Invalid GitHub identifier");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Invalid GitHub list");
  return value;
}
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: 20_000 }).trim();
}
function api(repository: string, route: string): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${route}`], {
      encoding: "utf8",
      timeout: 20_000,
    }),
  );
}
function parseRun(value: unknown): EvidenceCandidate["run"] {
  const data = object(value);
  const head = data.head_repository === null ? null : object(data.head_repository);
  return {
    id: integer(data.id),
    run_attempt: integer(data.run_attempt),
    status: string(data.status),
    conclusion: data.conclusion === null ? null : string(data.conclusion),
    workflow_id: integer(data.workflow_id),
    path: string(data.path),
    event: string(data.event),
    head_sha: string(data.head_sha),
    head_repository: head === null ? null : { full_name: string(head.full_name) },
  };
}
function parseJobs(value: unknown): EvidenceCandidate["jobs"] {
  return array(object(value).jobs).map((value) => {
    const job = object(value);
    return {
      name: string(job.name),
      status: string(job.status),
      conclusion: job.conclusion === null ? null : string(job.conclusion),
      completed_at: job.completed_at === null ? "" : string(job.completed_at),
    };
  });
}
function runnerImage(): string {
  const { ImageOS, ImageVersion } = process.env;
  return ImageOS && ImageVersion ? `${ImageOS}/${ImageVersion}` : "";
}
function outputs(values: Record<string, string>): void {
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(values)) {
      if (value.includes("\n") || value.includes("\r")) throw Error("Invalid CI output");
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
  console.log(JSON.stringify(values));
}
function identity() {
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    workflow: createHash("sha256").update(readFileSync(".github/workflows/ci.yml")).digest("hex"),
    image: runnerImage(),
  };
}
function request(repository: string): CiRequest {
  const source = identity();
  let workflowId = 0;
  try {
    workflowId = integer(object(api(repository, "actions/workflows/ci.yml")).id);
  } catch {
    /* Without trusted workflow metadata no previous run can authorize reuse. */
  }
  return {
    event: process.env.CI_NIGHTLY === "true" ? "nightly" : (process.env.GITHUB_EVENT_NAME ?? ""),
    ref: process.env.GITHUB_REF ?? "",
    repository,
    workflowId,
    tree: source.tree,
    workflow: source.workflow,
    toolchain: {
      node: process.env.NODE_VERSION ?? "",
      npm: process.env.NPM_VERSION ?? "",
      pnpm: process.env.PNPM_VERSION ?? "",
    },
    images: {
      linux: process.env.CI_LINUX_IMAGE ?? source.image,
      windows: process.env.CI_WINDOWS_IMAGE ?? "",
    },
  };
}
function backend(repository: string, now: number): EvidenceBackend {
  const deadline = Date.now() + 120_000;
  function requireBudget(): void {
    if (Date.now() >= deadline) throw Error("Evidence lookup budget exhausted");
  }
  function checkedApi(route: string): unknown {
    requireBudget();
    return api(repository, route);
  }
  return {
    listRuns: () => {
      const runs: EvidenceCandidate["run"][] = [];
      const since = encodeURIComponent(`>=${new Date(now - 48 * 60 * 60 * 1000).toISOString()}`);
      for (let page = 1; page <= 4; page++) {
        const data = object(
          checkedApi(
            `actions/workflows/ci.yml/runs?status=completed&created=${since}&per_page=50&page=${page}`,
          ),
        );
        const entries = array(data.workflow_runs);
        runs.push(...entries.map(parseRun));
        if (entries.length < 50) break;
      }
      return Promise.resolve(runs);
    },
    readEvidence: (runId, attempt) => {
      requireBudget();
      mkdirSync(".agents/tmp", { recursive: true });
      const directory = mkdtempSync(".agents/tmp/ci-evidence-download-");
      try {
        execFileSync(
          "gh",
          [
            "run",
            "download",
            String(runId),
            "--repo",
            repository,
            "--name",
            `ci-evidence-${attempt}`,
            "--dir",
            directory,
          ],
          { stdio: "pipe", timeout: 20_000 },
        );
        const bytes = readFileSync(path.join(directory, "evidence.json"));
        if (bytes.length > 16_384) throw Error("Unexpected evidence size");
        return Promise.resolve(JSON.parse(bytes.toString("utf8")) as unknown);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    testedTree: (commit) =>
      Promise.resolve(string(object(object(checkedApi(`git/commits/${commit}`)).tree).sha)),
    listJobs: (runId, attempt) =>
      Promise.resolve(
        parseJobs(checkedApi(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)),
      ),
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "identity") {
    outputs(identity());
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw Error("Missing CI repository");
  const current = request(repository);
  const now = Date.now();
  if (mode === "decide") {
    const decision = await lookupCiEvidence(current, backend(repository, now), now);
    outputs({
      full: String(decision.full),
      source_run: decision.sourceRun ? String(decision.sourceRun) : "",
      reason: decision.reason,
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const source = decision.sourceRun
        ? `\n\nSource: https://github.com/${repository}/actions/runs/${decision.sourceRun}`
        : "";
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## CI plan\n\n${decision.full ? "Full checks required" : "Reusing full CI evidence"}\n\n${decision.reason}${source}\n\nTested tree: \`${current.tree}\`\n`,
      );
    }
    return;
  }
  if (mode !== "record") throw Error("Expected identity, decide or record");
  if (process.env.CI_FULL !== "true") throw Error("An evidence-only run cannot record full proof");
  if (process.env.CI_WINDOWS_TREE !== current.tree || process.env.CI_LINUX_TREE !== current.tree)
    throw Error("Linux and Windows did not test the same recorded tree");
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const pull = object(event).pull_request;
  const headCommit = pull ? string(object(object(pull).head).sha) : (process.env.GITHUB_SHA ?? "");
  const evidence: CiEvidence = {
    schema: 1,
    kind: "full",
    repository,
    workflowId: current.workflowId,
    workflow: current.workflow,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    headCommit,
    testedCommit: git("rev-parse", "HEAD"),
    tree: current.tree,
    recordedAt: new Date(now).toISOString(),
    toolchain: current.toolchain,
    images: current.images,
  };
  const parsed = parseCiEvidence(evidence);
  if (!parsed) {
    outputs({
      recorded: "false",
      reason: "Full checks ran, but compatible runner metadata is unavailable",
    });
    return;
  }
  const source = backend(repository, now);
  const jobs = await source.listJobs(evidence.runId, evidence.runAttempt);
  const proof = decideCiRun(
    { ...current, event: "push", ref: "refs/heads/main" },
    [
      {
        evidence,
        run: {
          id: evidence.runId,
          run_attempt: evidence.runAttempt,
          status: "completed",
          conclusion: "success",
          workflow_id: evidence.workflowId,
          path: ".github/workflows/ci.yml",
          event: "push",
          head_sha: headCommit,
          head_repository: { full_name: repository },
        },
        testedTree: current.tree,
        jobs,
      },
    ],
    now,
  );
  if (proof.full) throw Error(`Full jobs cannot grant evidence: ${proof.reason}`);
  mkdirSync(".agents/tmp/ci-evidence", { recursive: true });
  writeFileSync(".agents/tmp/ci-evidence/evidence.json", JSON.stringify(parsed, null, 2) + "\n");
  outputs({ recorded: "true" });
}
await main();
