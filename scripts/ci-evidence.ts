/** Inputs that identify the current product and verification conditions. */
export interface CiRequest {
  event: string;
  ref: string;
  repository: string;
  workflowId: number;
  tree: string;
  workflow: string;
  toolchain: { node: string; npm: string; pnpm: string };
  images: { linux: string; windows: string };
}

/** Retained proof from a full run, never from an evidence-only check. */
export interface CiEvidence {
  schema: number;
  kind: string;
  repository: string;
  workflowId: number;
  workflow: string;
  runId: number;
  runAttempt: number;
  headCommit: string;
  testedCommit: string;
  tree: string;
  recordedAt: string;
  toolchain: CiRequest["toolchain"];
  images: CiRequest["images"];
}

/** Independent GitHub provenance paired with an untrusted artifact payload. */
export interface EvidenceCandidate {
  evidence: unknown;
  run: {
    id: number;
    run_attempt: number;
    status: string;
    conclusion: string | null;
    workflow_id: number;
    path: string;
    event: string;
    head_sha: string;
    head_repository: { full_name: string } | null;
  };
  testedTree: string;
  jobs: { name: string; status: string; conclusion: string | null; completed_at: string }[];
}

/** A reuse decision names the full source run; otherwise tests must execute. */
export interface CiDecision {
  full: boolean;
  reason: string;
  sourceRun?: number;
}

const maximumAge = 24 * 60 * 60 * 1000;
const commitHash = /^[a-f0-9]{40}$/u;
const workflowHash = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Reads only complete full-run records; malformed and reused artifacts are not proof. */
export function parseCiEvidence(value: unknown): CiEvidence | undefined {
  const data = record(value);
  if (!data) return undefined;
  const toolchain = record(data.toolchain);
  const images = record(data.images);
  if (
    data.schema !== 1 ||
    data.kind !== "full" ||
    !nonempty(data.repository) ||
    !positiveInteger(data.workflowId) ||
    !positiveInteger(data.runId) ||
    !positiveInteger(data.runAttempt) ||
    !nonempty(data.workflow) ||
    !workflowHash.test(data.workflow) ||
    !nonempty(data.headCommit) ||
    !commitHash.test(data.headCommit) ||
    !nonempty(data.testedCommit) ||
    !commitHash.test(data.testedCommit) ||
    !nonempty(data.tree) ||
    !commitHash.test(data.tree) ||
    !nonempty(data.recordedAt) ||
    !Number.isFinite(Date.parse(data.recordedAt)) ||
    !toolchain ||
    !images ||
    !nonempty(toolchain.node) ||
    !nonempty(toolchain.npm) ||
    !nonempty(toolchain.pnpm) ||
    !nonempty(images.linux) ||
    !nonempty(images.windows)
  )
    return undefined;
  return {
    schema: 1,
    kind: "full",
    repository: data.repository,
    workflowId: data.workflowId,
    workflow: data.workflow,
    runId: data.runId,
    runAttempt: data.runAttempt,
    headCommit: data.headCommit,
    testedCommit: data.testedCommit,
    tree: data.tree,
    recordedAt: data.recordedAt,
    toolchain: { node: toolchain.node, npm: toolchain.npm, pnpm: toolchain.pnpm },
    images: { linux: images.linux, windows: images.windows },
  };
}

/** Rejects foreign, incomplete and wrong-workflow runs before artifact access. */
export function isTrustedCiRun(request: CiRequest, run: EvidenceCandidate["run"]): boolean {
  return (
    positiveInteger(run.id) &&
    positiveInteger(run.run_attempt) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.head_repository?.full_name === request.repository &&
    run.workflow_id === request.workflowId &&
    run.path === ".github/workflows/ci.yml" &&
    ["pull_request", "push"].includes(run.event)
  );
}
function rejection(
  request: CiRequest,
  candidate: EvidenceCandidate,
  now: number,
): string | undefined {
  const evidence = parseCiEvidence(candidate.evidence);
  if (!evidence) return "Missing or malformed full-run evidence";
  const { run } = candidate;
  if (
    !isTrustedCiRun(request, run) ||
    run.id !== evidence.runId ||
    run.run_attempt !== evidence.runAttempt ||
    run.head_sha !== evidence.headCommit
  )
    return "Evidence does not belong to a successful trusted CI run";
  if (evidence.repository !== request.repository || evidence.workflowId !== request.workflowId)
    return "Evidence repository or workflow differs";
  if (evidence.tree !== request.tree || candidate.testedTree !== evidence.tree)
    return "The actual tested tree differs";
  if (evidence.workflow !== request.workflow) return "The verification workflow differs";
  for (const key of ["node", "npm", "pnpm"] as const) {
    if (evidence.toolchain[key] !== request.toolchain[key]) return `The ${key} pin differs`;
  }
  for (const key of ["linux", "windows"] as const) {
    if (!nonempty(request.images[key]) || evidence.images[key] !== request.images[key])
      return `The ${key} runner image differs or is unknown`;
  }
  const age = now - Date.parse(evidence.recordedAt);
  if (!Number.isFinite(age) || age < 0 || age > maximumAge)
    return "Full-run evidence is outside the 24-hour window";
  for (const name of ["Validate", "Validate Windows core"]) {
    const matches = candidate.jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0]?.status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      return `${name} did not complete successfully in the full run`;
    const jobAge = now - Date.parse(matches[0].completed_at);
    if (!Number.isFinite(jobAge) || jobAge < 0 || jobAge > maximumAge)
      return `${name} completion is outside the 24-hour window`;
  }
  return undefined;
}

/** Reuses only exact, recent full-run proof for main/develop pushes; all other events run fully. */
export function decideCiRun(
  request: CiRequest,
  candidates: readonly EvidenceCandidate[],
  now: number,
): CiDecision {
  if (request.event !== "push" || !["refs/heads/main", "refs/heads/develop"].includes(request.ref))
    return { full: true, reason: "PR, nightly and other events require a full run" };
  let reason = "No retained compatible full-run evidence";
  for (const candidate of candidates) {
    const rejected = rejection(request, candidate, now);
    if (rejected) {
      reason = rejected;
      continue;
    }
    return {
      full: false,
      sourceRun: candidate.run.id,
      reason: `Reusing full CI run ${candidate.run.id} for the same tested tree and conditions`,
    };
  }
  return { full: true, reason };
}
