import type { ApplyFileAccess, ApplyFileAccessProvider } from "#src/api/apply-files.js";
import type { ApplyUndoStore } from "#src/core/apply/apply-undo-store.js";

/** One session's journal store and the owners that must outlive its receipts. */
export interface ApplyUndoOwner {
  readonly access: ApplyFileAccess;
  readonly store: ApplyUndoStore;
  readonly providers: readonly ApplyFileAccessProvider[];
}

/** Single-use handoff between extension instances in the same process and session. */
export interface RetainedApplyUndo {
  take(): ApplyUndoOwner;
  dispose(): Promise<void>;
}

/** Release receipts before their resource owners. Failed cleanup remains retryable. */
export async function disposeApplyUndoOwner(owner: ApplyUndoOwner): Promise<void> {
  await owner.store.dispose();
  const outcomes = await Promise.allSettled(
    [...new Set(owner.providers)].map((provider) => provider.dispose?.()),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Apply file owner cleanup failed");
}

/** Keep opaque backups alive until a new core takes ownership or cleanup succeeds. */
export function retainApplyUndoOwner(owner: ApplyUndoOwner): RetainedApplyUndo {
  let consumed = false;
  return {
    take() {
      if (consumed) throw new Error("Apply journal ownership was already transferred or released.");
      consumed = true;
      return owner;
    },
    async dispose() {
      if (consumed) return;
      await disposeApplyUndoOwner(owner);
      consumed = true;
    },
  };
}
