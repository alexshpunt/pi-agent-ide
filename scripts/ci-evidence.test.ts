import { expect, test } from "vitest";
import {
  decideCiRun,
  type CiEvidence,
  type CiRequest,
  type EvidenceCandidate,
} from "#scripts/ci-evidence.ts";

const now = Date.parse("2026-10-08T14:00:00Z");
const request: CiRequest = {
  event: "push",
  ref: "refs/heads/main",
  repository: "alexshpunt/pi-agent-ide",
  workflowId: 159038,
  tree: "a".repeat(40),
  workflow: "b".repeat(64),
  toolchain: { node: "24.19.0", npm: "11.19.0", pnpm: "11.22.0" },
  images: { linux: "ubuntu24/20261005.1", windows: "windows2025/20261005.1" },
};
function candidate(): EvidenceCandidate & { evidence: CiEvidence } {
  return {
    evidence: {
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
      toolchain: { ...request.toolchain },
      images: { ...request.images },
    },
    run: {
      id: 1234,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      workflow_id: request.workflowId,
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      head_sha: "c".repeat(40),
      head_repository: { full_name: request.repository },
    },
    testedTree: request.tree,
    jobs: [
      {
        name: "Validate",
        status: "completed",
        conclusion: "success",
        completed_at: new Date(now - 60_000).toISOString(),
      },
      {
        name: "Validate Windows core",
        status: "completed",
        conclusion: "success",
        completed_at: new Date(now - 60_000).toISOString(),
      },
    ],
  };
}

test("reuses a complete trusted run for the exact tested tree after squash merge", () => {
  const source = candidate();
  expect(source.evidence.testedCommit).not.toBe(source.run.head_sha);
  expect(decideCiRun(request, [source], now)).toMatchObject({ full: false, sourceRun: 1234 });
  expect(decideCiRun({ ...request, ref: "refs/heads/develop" }, [source], now)).toMatchObject({
    full: false,
    sourceRun: 1234,
  });
});

test.each(["pull_request", "workflow_call", "workflow_dispatch"])(
  "%s still runs fully even with matching evidence",
  (event) => expect(decideCiRun({ ...request, event }, [candidate()], now).full).toBe(true),
);

test("an unrelated push ref and a new develop combination need full tests", () => {
  expect(decideCiRun({ ...request, ref: "refs/heads/feature" }, [candidate()], now).full).toBe(
    true,
  );
  expect(
    decideCiRun({ ...request, ref: "refs/heads/develop", tree: "e".repeat(40) }, [candidate()], now)
      .full,
  ).toBe(true);
});

test("missing evidence is a fresh run, not a successful skipped check", () => {
  expect(decideCiRun(request, [], now)).toMatchObject({ full: true });
  expect(decideCiRun(request, [{ ...candidate(), evidence: null }], now).full).toBe(true);
});

const invalidSources: readonly [string, (source: EvidenceCandidate) => void][] = [
  ["failed run", (source: EvidenceCandidate) => (source.run.conclusion = "failure")],
  ["pending run", (source: EvidenceCandidate) => (source.run.status = "in_progress")],
  ["foreign repository", (source: EvidenceCandidate) => (source.run.head_repository = null)],
  ["wrong workflow", (source: EvidenceCandidate) => (source.run.workflow_id = 999)],
  [
    "wrong workflow path",
    (source: EvidenceCandidate) => (source.run.path = ".github/workflows/other.yml"),
  ],
  ["wrong head", (source: EvidenceCandidate) => (source.run.head_sha = "e".repeat(40))],
  ["rerun attempt", (source: EvidenceCandidate) => (source.run.run_attempt = 2)],
  ["wrong run", (source: EvidenceCandidate) => (source.run.id = 999)],
  ["wrong tested tree", (source: EvidenceCandidate) => (source.testedTree = "e".repeat(40))],
  ["missing Windows job", (source: EvidenceCandidate) => source.jobs.pop()],
  [
    "skipped Windows job",
    (source: EvidenceCandidate) => {
      source.jobs[1] = {
        name: "Validate Windows core",
        status: "completed",
        conclusion: "skipped",
        completed_at: new Date(now - 60_000).toISOString(),
      };
    },
  ],
  [
    "failed Linux job",
    (source: EvidenceCandidate) => {
      source.jobs[0] = {
        name: "Validate",
        status: "completed",
        conclusion: "failure",
        completed_at: new Date(now - 60_000).toISOString(),
      };
    },
  ],
];

test.each(invalidSources)("rejects %s without inheriting green status", (_name, mutate) => {
  const source = candidate();
  mutate(source);
  expect(decideCiRun(request, [source], now).full).toBe(true);
});

test.each([
  ["changed workflow", { workflow: "f".repeat(64) }],
  ["changed Node pin", { toolchain: { ...request.toolchain, node: "25.0.0" } }],
  ["changed npm pin", { toolchain: { ...request.toolchain, npm: "12.0.0" } }],
  ["changed pnpm pin", { toolchain: { ...request.toolchain, pnpm: "12.0.0" } }],
  ["changed Linux image", { images: { ...request.images, linux: "ubuntu26/new" } }],
  ["changed Windows image", { images: { ...request.images, windows: "windows2025/new" } }],
])("%s invalidates earlier verification", (_name, change) => {
  expect(decideCiRun({ ...request, ...change }, [candidate()], now).full).toBe(true);
});

test("proof expires after 24 hours, and future timestamps cannot extend it", () => {
  const source = candidate();
  source.evidence.recordedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  expect(decideCiRun(request, [source], now).full).toBe(false);
  expect(decideCiRun(request, [source], now + 1).full).toBe(true);
  source.evidence.recordedAt = new Date(now + 1).toISOString();
  expect(decideCiRun(request, [source], now).full).toBe(true);
});

test("rerunning the evidence recorder cannot refresh old test jobs", () => {
  const source = candidate();
  for (const job of source.jobs)
    job.completed_at = new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString();
  expect(decideCiRun(request, [source], now).full).toBe(true);
});

test("unknown test completion time cannot prove fresh verification", () => {
  const source = candidate();
  for (const job of source.jobs) job.completed_at = "";
  expect(decideCiRun(request, [source], now).full).toBe(true);
});
test("reused checks cannot create a chain of fresh-looking full evidence", () => {
  const source = candidate();
  expect(
    decideCiRun(request, [{ ...source, evidence: { ...source.evidence, kind: "reused" } }], now)
      .full,
  ).toBe(true);
});

test("a broken candidate does not hide a later complete matching run", () => {
  const bad = candidate();
  bad.run.conclusion = "failure";
  expect(decideCiRun(request, [bad, candidate()], now)).toMatchObject({
    full: false,
    sourceRun: 1234,
  });
});
