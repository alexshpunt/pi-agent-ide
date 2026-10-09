import type { ClassifierResult } from "@earendil-works/pi-ai";

/** Model labels are attention signals, not confirmed defects. */
export type Decision = "candidate" | "clear" | "unknown" | "error";

/** Reject invalid answers rather than turning a provider failure into a clear test. */
export function decision(result: ClassifierResult): Decision {
  const answer = result.answers.coupling;
  if (result.stopReason !== "stop" || answer?.type !== "choice") return "error";
  if (!["candidate", "clear", "unknown"].includes(answer.choice)) return "error";
  const probability = answer.probabilities[answer.choice];
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    return "error";
  return answer.choice as Decision;
}

/** Identity and snapshot needed to account for each queued candidate. */
export interface ReviewCandidate {
  id: string;
  file: string;
  sourceHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Verify review coverage and source freshness, not the semantic truth of an agent's judgement. */
export function validateReviews(
  candidates: readonly ReviewCandidate[],
  data: unknown,
  currentHashes: ReadonlyMap<string, string>,
) {
  if (!Array.isArray(data)) throw new Error("review.json must be an array.");
  const expected = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const counts = { reviewed: 0, confirmed: 0, falsePositives: 0, needsContext: 0 };
  for (const item of data as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      !Array.isArray(item.evidence) ||
      !item.evidence.length
    )
      throw new Error("Each review needs an id, reason, and source evidence.");
    const candidate = expected.get(item.id);
    if (!candidate || seen.has(item.id)) throw new Error("Unknown or duplicate candidate review.");
    if (currentHashes.get(candidate.file) !== candidate.sourceHash)
      throw new Error("Candidate source changed. Rerun the scan before closing its review.");
    for (const evidence of item.evidence as unknown[]) {
      if (
        !isRecord(evidence) ||
        typeof evidence.file !== "string" ||
        !evidence.file.trim() ||
        typeof evidence.line !== "number" ||
        !Number.isInteger(evidence.line) ||
        evidence.line < 1
      )
        throw new Error("Evidence needs a file and a positive line number.");
    }
    if (item.verdict === "confirmed") counts.confirmed += 1;
    else if (item.verdict === "false-positive") counts.falsePositives += 1;
    else if (item.verdict === "needs-context") counts.needsContext += 1;
    else throw new Error("Use confirmed, false-positive, or needs-context.");
    seen.add(item.id);
    counts.reviewed += 1;
  }
  if (seen.size !== expected.size) throw new Error("Some candidates have not been reviewed.");
  return counts;
}
