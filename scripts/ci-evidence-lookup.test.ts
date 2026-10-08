import { expect, test } from "vitest";
import { lookupCiEvidence, type EvidenceBackend } from "#scripts/ci-evidence-lookup.ts";
import type { CiEvidence, CiRequest, EvidenceCandidate } from "#scripts/ci-evidence.ts";

const now = Date.parse("2026-10-08T14:00:00Z");
function fixture() {
  const request: CiRequest = {
    event: "push",
    ref: "refs/heads/main",
    repository: "alexshpunt/pi-agent-ide",
    workflowId: 338606493,
    tree: "a".repeat(40),
    workflow: "b".repeat(64),
    toolchain: { node: "24.19.0", npm: "11.19.0", pnpm: "11.22.0" },
    images: { linux: "ubuntu24/20261005.1", windows: "windows2025/20261005.1" },
  };
  const evidence: CiEvidence = {
    schema: 1,
    kind: "full",
    repository: request.repository,
    workflowId: request.workflowId,
    workflow: request.workflow,
    runId: 1234,
    runAttempt: 1,
    headCommit: "c".repeat(40),
    testedCommit: "d".repeat(40),
    tree: request.tree,
    recordedAt: new Date(now - 60_000).toISOString(),
    toolchain: request.toolchain,
    images: request.images,
  };
  const run: EvidenceCandidate["run"] = {
    id: 1234,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow_id: request.workflowId,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: evidence.headCommit,
    head_repository: { full_name: request.repository },
  };
  const calls: string[] = [];
  const backend: EvidenceBackend = {
    listRuns: async () => {
      calls.push("runs");
      return [run];
    },
    readEvidence: async (id, attempt) => {
      calls.push(`artifact:${id}:${attempt}`);
      return evidence;
    },
    testedTree: async (commit) => {
      calls.push(`tree:${commit}`);
      return request.tree;
    },
    listJobs: async (id, attempt) => {
      calls.push(`jobs:${id}:${attempt}`);
      return ["Validate", "Validate Windows core"].map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        completed_at: evidence.recordedAt,
      }));
    },
  };
  return { request, evidence, run, calls, backend };
}

test("checks the actual tested commit and the exact successful run attempt before reusing", async () => {
  const data = fixture();
  expect(await lookupCiEvidence(data.request, data.backend, now)).toMatchObject({
    full: false,
    sourceRun: 1234,
  });
  expect(data.calls).toEqual([
    "runs",
    "artifact:1234:1",
    `tree:${data.evidence.testedCommit}`,
    "jobs:1234:1",
  ]);
});

test("PR and nightly do not ask a remote cache to authorize skipping tests", async () => {
  const data = fixture();
  for (const event of ["pull_request", "workflow_call"]) {
    expect((await lookupCiEvidence({ ...data.request, event }, data.backend, now)).full).toBe(true);
  }
  expect(data.calls).toEqual([]);
});

test("unavailable GitHub metadata means fresh tests", async () => {
  const data = fixture();
  data.backend.listRuns = async () => {
    throw Error("API unavailable");
  };
  expect(await lookupCiEvidence(data.request, data.backend, now)).toMatchObject({ full: true });
});

test("missing or malformed artifacts cannot authorize a reused gate", async () => {
  for (const payload of [null, {}, { ...fixture().evidence, kind: "reused" }]) {
    const data = fixture();
    data.backend.readEvidence = async () => payload;
    expect((await lookupCiEvidence(data.request, data.backend, now)).full).toBe(true);
    expect(data.calls).toEqual(["runs"]);
  }
});

test("a failed or foreign run is rejected before downloading its artifact", async () => {
  const data = fixture();
  data.run.conclusion = "failure";
  expect((await lookupCiEvidence(data.request, data.backend, now)).full).toBe(true);
  expect(data.calls).toEqual(["runs"]);
});

test("an expired download or missing tested commit cannot hide a full-run requirement", async () => {
  for (const stage of ["artifact", "tree", "jobs"] as const) {
    const data = fixture();
    const unavailable = async () => {
      throw Error("Unavailable evidence");
    };
    if (stage === "artifact") data.backend.readEvidence = unavailable;
    if (stage === "tree") data.backend.testedTree = unavailable;
    if (stage === "jobs") data.backend.listJobs = unavailable;
    expect((await lookupCiEvidence(data.request, data.backend, now)).full).toBe(true);
  }
});
