import {
  decideCiRun,
  isTrustedCiRun,
  parseCiEvidence,
  type CiDecision,
  type CiRequest,
  type EvidenceCandidate,
} from "./ci-evidence.ts";

/** Read-only evidence operations supplied by the GitHub adapter. */
export interface EvidenceBackend {
  listRuns(): Promise<EvidenceCandidate["run"][]>;
  readEvidence(runId: number, attempt: number): Promise<unknown>;
  testedTree(commit: string): Promise<string>;
  listJobs(runId: number, attempt: number): Promise<EvidenceCandidate["jobs"]>;
}

/** Resolves a trusted full run, falling back to fresh tests whenever proof is unavailable. */
export async function lookupCiEvidence(
  request: CiRequest,
  backend: EvidenceBackend,
  now: number,
): Promise<CiDecision> {
  const fallback = decideCiRun(request, [], now);
  if (request.event !== "push" || !["refs/heads/main", "refs/heads/develop"].includes(request.ref))
    return fallback;
  let runs: EvidenceCandidate["run"][];
  try {
    runs = await backend.listRuns();
  } catch {
    return { full: true, reason: "GitHub evidence metadata is unavailable; running full checks" };
  }
  let decision = fallback;
  for (const run of runs) {
    if (!isTrustedCiRun(request, run)) continue;
    try {
      const evidence = parseCiEvidence(await backend.readEvidence(run.id, run.run_attempt));
      if (!evidence || evidence.tree !== request.tree) continue;
      const testedTree = await backend.testedTree(evidence.testedCommit);
      const jobs = await backend.listJobs(run.id, run.run_attempt);
      decision = decideCiRun(request, [{ evidence, run, testedTree, jobs }], now);
      if (!decision.full) return decision;
    } catch {
      decision = { full: true, reason: "Retained CI proof is unavailable; running full checks" };
    }
  }
  return decision;
}
