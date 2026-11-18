import {
  compactMutationReceipt,
  type CompactMutationReceipt,
  type FileMutationBatchResult,
  type MutationDiffStatus,
} from "pi-agent-text-editor/api/mutation-result";
import { resolveMutationResultResources } from "./mutation-result.ts";
import type { DiffModel, DiffRow } from "./diff-model.ts";

const WINDOW_BYTES = 16 * 1024;

/** Width- and theme-independent fragments retained in session history. */
export interface PersistedMutationResource {
  readonly path: string;
  readonly model: DiffModel;
  readonly diffStatuses?: readonly MutationDiffStatus[];
}

/** Completed history owns diff fragments, not the engine's document snapshots. */
export interface PersistedMutationDetails extends CompactMutationReceipt {
  readonly mutationRender?: readonly PersistedMutationResource[];
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Projects a finished result after its model-facing answer has been prepared. */
export function compactMutationDetails(details: FileMutationBatchResult): PersistedMutationDetails {
  const resources = resolveMutationResultResources(details, undefined);
  const receipt = compactMutationReceipt(details);
  // Share one budget across the entire result. Charge for escaped JSON, not string length.
  const mutationRender: PersistedMutationResource[] = [];
  let remaining = WINDOW_BYTES;
  let truncated = receipt.mutationDetailsTruncated === true;
  for (const { path, model, diffStatuses } of resources) {
    if (model === undefined) continue;
    const rows: DiffRow[] = [];
    const window = {
      path,
      model: { ...model, rows },
      ...(diffStatuses === undefined ? {} : { diffStatuses }),
    };
    remaining -= jsonBytes(window) + 1;
    if (remaining < 0) {
      truncated = true;
      break;
    }
    for (const row of model.rows) {
      const size = jsonBytes(row) + 1;
      if (remaining < size) {
        truncated = true;
        break;
      }
      remaining -= size;
      rows.push(row);
    }
    // Find the actual focus in the kept prefix, or show the final kept row.
    window.model.focusRow = Math.max(0, Math.min(model.focusRow, rows.length - 1));
    mutationRender.push(window);
  }
  return {
    ...receipt,
    mutationRender,
    ...(truncated ? { mutationDetailsTruncated: true } : {}),
  };
}
