import { AsyncLocalStorage } from "node:async_hooks";
import type { TextResourceEditOutcome } from "./text-editor-core.js";

type Completed = Exclude<TextResourceEditOutcome<unknown>, { readonly kind: "failed" }>;
type Finalize = () => Promise<Completed>;
const active = new AsyncLocalStorage<Map<string, Finalize>>();
const notifications = new AsyncLocalStorage<Array<() => void>>();

/** Schedule observers only after every file in the current finalization has settled. */
export function afterPostEditScope(notify: () => void): void {
  const pending = notifications.getStore();
  if (pending) pending.push(notify);
  else notify();
}

/** Keep post-edit notifications behind the final processing of all files. */
export async function collectPostEditNotifications<T>(work: () => Promise<T>): Promise<T> {
  if (notifications.getStore()) return work();
  const pending: Array<() => void> = [];
  try {
    return await notifications.run(pending, work);
  } finally {
    for (const notify of pending) notify();
  }
}

/** Replace intermediate post-processing with the latest written state of this resource. */
export function deferPostEdit(source: string, finalize: Finalize): boolean {
  const pending = active.getStore();
  if (!pending) return false;
  pending.set(source, finalize);
  return true;
}

/** Optional read enrichment must not start checks on an intermediate edited snapshot. */
export function hasDeferredPostEdit(source: string): boolean {
  return active.getStore()?.has(source) ?? false;
}
/** Writes stay immediate; finishing drains each surviving final resource once. */
export function createPostEditScope() {
  const pending = new Map<string, Finalize>();
  return {
    run<T>(operation: () => T): T {
      return active.run(pending, operation);
    },
    forget(source: string): void {
      pending.delete(source);
    },
    async finish(onCompleted?: (outcome: Completed) => void): Promise<Completed[]> {
      const work = [...pending.values()];
      pending.clear();
      const completed: Completed[] = [];
      const errors: unknown[] = [];
      await collectPostEditNotifications(async () => {
        for (const finalize of work) {
          try {
            const outcome = await finalize();
            completed.push(outcome);
            onCompleted?.(outcome);
          } catch (error) {
            errors.push(error);
          }
        }
      });
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          `Some final post-processing failed; completed edits remain applied. ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
        );
      return completed;
    },
  };
}
