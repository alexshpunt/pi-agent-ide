import { AsyncLocalStorage } from "node:async_hooks";
import { ResourceScheduler, resourceAccesses } from "pi-agent-resource";
import type { TextResourceEditOutcome } from "./text-editor-core.js";

type Completed = Exclude<TextResourceEditOutcome<unknown>, { readonly kind: "failed" }>;
type Finalize = () => Promise<Completed>;
const active = new AsyncLocalStorage<{
  readonly pending: Map<string, Finalize>;
  readonly immediate: boolean;
}>();
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
  const scope = active.getStore();
  if (!scope) return false;
  if (scope.immediate) {
    scope.pending.delete(source);
    return false;
  }
  scope.pending.set(source, finalize);
  return true;
}

/** Optional read enrichment must not start checks on an intermediate edited snapshot. */
export function hasDeferredPostEdit(source: string): boolean {
  return active.getStore()?.pending.has(source) ?? false;
}

/** Stop deferred processing when a later operation removes or moves the resource. */
export function forgetDeferredPostEdit(source: string): void {
  active.getStore()?.pending.delete(source);
}
/** Writes stay immediate; finishing drains each surviving final resource once. */
export function createPostEditScope(cwd = process.cwd()) {
  const pending = new Map<string, Finalize>();
  return {
    /** Immediate processing replaces older deferred work for the same written resource. */
    run<T>(operation: () => T, immediate = false): T {
      return active.run({ pending, immediate }, operation);
    },
    forget(source: string): void {
      pending.delete(source);
    },
    /** Complete resource set that finish may modify. */
    sources(): readonly string[] {
      return [...pending.keys()];
    },
    async finish(onCompleted?: (outcome: Completed) => void): Promise<Completed[]> {
      const work = [...pending];
      pending.clear();
      const completed: Completed[] = [];
      const errors: unknown[] = [];
      await collectPostEditNotifications(async () => {
        const scheduler = new ResourceScheduler();
        const outcomes = await Promise.allSettled(
          work.map(([source, finalize]) =>
            scheduler.run(resourceAccesses(source, cwd, "write"), finalize),
          ),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            errors.push(outcome.reason);
            continue;
          }
          completed.push(outcome.value);
          try {
            onCompleted?.(outcome.value);
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
