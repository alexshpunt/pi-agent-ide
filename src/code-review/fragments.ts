import { structuredPatch } from "diff";

/** The complete bounded hunk sent to the classifier, including old and new line ranges. */
export interface ReviewFragment {
  readonly diff: string;
}

/** Split the saved change into complete hunks with three context lines on each side. */
export function reviewFragments(before: string, after: string): readonly ReviewFragment[] {
  if (before === after) return [];
  if (before.length + after.length > 300_000)
    throw new Error("File is too large for automatic review.");
  const patch = structuredPatch("before", "after", before, after, undefined, undefined, {
    context: 3,
    timeout: 100,
  });
  if (!patch) throw new Error("Diff exceeded the automatic review time limit.");
  if (patch.hunks.length > 16)
    throw new Error("Change has too many fragments for automatic review (16 limit).");
  return patch.hunks.map((hunk) => {
    const diff = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`;
    if (diff.length > 12_000)
      throw new Error("Fragment is too large for automatic review (12000 character limit).");
    return { diff };
  });
}
