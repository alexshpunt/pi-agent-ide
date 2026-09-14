import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";
import { createUnifiedDiff } from "#src/core/mutation-result/diff.js";
import type { ApplyResults } from "./results.js";
import type { ScriptMutationOutcome } from "./mutation-outcome.js";

/** Project recorded net effects into the same presentation model as standalone edits. */
export function finalApplyMutations(results: ApplyResults): FileMutationResult[] {
  const selected = results.select();
  const mutations = results.mutationValues().filter(isMutation);
  return selected.files.map((file) => {
    const receipts = mutations.flatMap((outcome) =>
      outcome.files
        .filter((changed) => changed.source === file.source)
        .map((changed) => ({ outcome, changed })),
    );
    const presentation = results.mutationPresentation(file.source)?.data;
    const latest = presentation?.afterContent === file.after ? presentation : undefined;
    return new FileMutationResult({
      ok: true,
      path: file.source,
      files: [{ path: file.source, action: file.before === null ? "created" : "edited" }],
      snapshot: { content: file.before ?? "" },
      beforeContentMap: { [file.source]: file.before },
      afterContent: file.after ?? "",
      afterDocument: latest?.afterDocument,
      resultPresentation: latest?.resultPresentation,
      scopeMarkers: latest?.scopeMarkers,
      hints: latest?.hints,
      warnings: latest?.warnings,
      diffStatuses: latest?.diffStatuses,
      diffs: [createUnifiedDiff(file.source, file.before ?? "", file.after ?? "").diff],
      operations: receipts.map(({ outcome, changed }) => ({
        operation: outcome.operation === "remove" ? "delete" : outcome.operation,
        changes: changed.changes.length,
      })),
      formatting: latest?.formatting ?? receipts.at(-1)?.changed.formatting,
    });
  });
}

function isMutation(value: unknown): value is ScriptMutationOutcome {
  return (
    value !== null &&
    typeof value === "object" &&
    "operation" in value &&
    "files" in value &&
    Array.isArray(value.files) &&
    "effect" in value
  );
}
