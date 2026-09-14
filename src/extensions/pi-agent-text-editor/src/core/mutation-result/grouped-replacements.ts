import type { FileMutationResult } from "./file-mutation-result.js";

/** Exact applied replacement pairs and complete per-file counts, before formatting. */
export interface GroupedReplacements {
  readonly groups: readonly { removedText: string; insertedText: string; count: number }[];
  readonly files: readonly { path: string; groups: readonly number[]; formatting: string }[];
  readonly changes: number;
}

/** Groups successful replacements only when every result has complete applied-change evidence. */
export function groupReplacements(
  results: readonly FileMutationResult[],
): GroupedReplacements | undefined {
  if (results.length === 0) return;
  const groups: { removedText: string; insertedText: string; count: number }[] = [];
  const indexes = new Map<string, number>();
  const files: { path: string; groups: number[]; formatting: string }[] = [];
  let changes = 0;
  for (const result of results) {
    const operations = result.data.operations;
    const raw = result.data.rawChanges;
    if (
      !result.ok ||
      result.isPartial ||
      result.warnings.length > 0 ||
      result.errors.length > 0 ||
      (result.data.hints?.length ?? 0) > 0 ||
      (result.data.diffStatuses?.length ?? 0) > 0 ||
      !result.path ||
      !operations?.length ||
      operations.some((operation) => operation.operation !== "replace") ||
      !raw?.length ||
      operations.reduce((sum, operation) => sum + operation.changes, 0) !== raw.length
    )
      return;
    const counts: number[] = [];
    for (const change of raw) {
      const key = JSON.stringify([change.removedText, change.insertedText]);
      let index = indexes.get(key);
      if (index === undefined) {
        index = groups.length;
        indexes.set(key, index);
        groups.push({
          removedText: change.removedText,
          insertedText: change.insertedText,
          count: 0,
        });
      }
      const group = groups[index];
      if (group === undefined) throw new Error("Missing replacement group");
      group.count++;
      counts[index] = (counts[index] ?? 0) + 1;
      changes++;
    }
    files.push({
      path: result.path,
      groups: counts,
      formatting: result.data.formatting?.status ?? "not-reported",
    });
  }
  // Keep ordinary final-state output when there is nothing repeated to compress.
  if (groups.length === changes) return;
  return { groups, files, changes };
}

/** Renders all unique pairs and every affected file without repeating surrounding source text. */
export function renderGroupedReplacements(receipt: GroupedReplacements): string {
  return [
    `Applied ${receipt.changes} replacements in ${receipt.files.length} files.`,
    "Exact applied replacements (before any additional formatting; not a full final-file view):",
    ...receipt.groups.map(
      (group, index) =>
        `G${index + 1}: ${JSON.stringify(group.removedText)} -> ${JSON.stringify(group.insertedText)} (${group.count} replacements)`,
    ),
    "Files (complete):",
    ...receipt.files.map(
      (file) =>
        `${file.path}: ${file.groups.flatMap((count, index) => (count ? [`G${index + 1} x ${count}`] : [])).join(", ")}; formatting: ${file.formatting}`,
    ),
  ].join("\n");
}
