import { readFile } from "node:fs/promises";
import path from "node:path";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { sourceHash } from "./discovery.ts";
import { validateReviews, type ReviewCandidate } from "./review.ts";

const root = findRepositoryRoot(import.meta.url);
const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error(
    "Usage: pnpm exec oxnode scripts/dev/prose-candidates/check-review.ts RUN_DIRECTORY",
  );
const output = path.resolve(root, directory);
const candidates = JSON.parse(
  await readFile(path.join(output, "candidates.json"), "utf8"),
) as ReviewCandidate[];
const reviews: unknown = JSON.parse(await readFile(path.join(output, "review.json"), "utf8"));
const hashes = new Map<string, string>();
function localFile(file: string) {
  const resolved = path.resolve(root, file);
  if (path.isAbsolute(file) || !resolved.startsWith(root + path.sep))
    throw new Error("Evidence and candidate files must be repository-relative paths.");
  return resolved;
}
for (const candidate of candidates)
  hashes.set(candidate.file, sourceHash(await readFile(localFile(candidate.file), "utf8")));
const counts = validateReviews(candidates, reviews, hashes);
// Coverage validation has already checked each evidence record's shape.
for (const review of reviews as { evidence: { file: string; line: number }[] }[])
  for (const evidence of review.evidence) {
    const source = await readFile(localFile(evidence.file), "utf8");
    if (evidence.line > source.split("\n").length)
      throw new Error("Evidence line is outside its source file.");
  }
const run = JSON.parse(await readFile(path.join(output, "run.json"), "utf8")) as {
  summary: { mode: string; complete: boolean; errors: number; pending: number; issues: unknown[] };
};
console.log(
  `Review coverage: ${counts.reviewed}/${candidates.length}; confirmed ${counts.confirmed}; false positives ${counts.falsePositives}; needs context ${counts.needsContext}.`,
);
console.log(
  `Complete repository scan: ${run.summary.complete}. Model errors: ${run.summary.errors}; pending: ${run.summary.pending}; discovery issues: ${run.summary.issues.length}.`,
);
console.log("Coverage and evidence locations checked, not the truth of the agent's judgement.");
if (run.summary.mode !== "live") throw new Error("Preparation is not a completed classifier run.");
