import { AsyncLocalStorage } from "node:async_hooks";
import { ResourceError } from "pi-agent-resource";
import type { TextEditRun } from "pi-agent-text";

import type { TextResourcesEditOutcome } from "#src/core/text-editor-core.ts";

/** Error code of a resolved target whose file changed before the edit used it. */
export const SOURCE_CHANGED = "SOURCE_CHANGED";

/**
 * Pauses before each new attempt while other processes keep writing the file. Random spread
 * keeps several waiting processes from colliding again at the same moment.
 */
const RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800, 1600];

/**
 * No new attempt starts once this much time has passed since the first attempt found newer text.
 * The budget measures how long another process keeps writing the file, so the first attempt's own
 * duration, such as a language server still starting, does not count.
 */
export const RETRY_BUDGET_MS = 10_000;

/** Clock and pause, replaceable in tests. */
export interface SourceChangeRetryTiming {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The edit gave up because another process kept writing its file. */
export class SourceKeptChangingError extends Error {
  public constructor(
    message: string,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceKeptChangingError";
  }
}

/**
 * Another Pi process may write the file between an edit's read and its write. The write is then
 * refused, and the edit runs again on the current text, anchors included. After the last attempt,
 * or once the time budget is spent, the failure says that the file kept changing.
 */
export async function retryWhenSourceChanged<Result>(
  apply: () => Promise<TextResourcesEditOutcome<Result>>,
  timing: SourceChangeRetryTiming = {},
): Promise<TextResourcesEditOutcome<Result>> {
  const now = timing.now ?? Date.now;
  const sleep =
    timing.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let started: number | undefined;
  const run: { attempt: number } = { attempt: 0 };
  for (let attempt = 0; ; attempt += 1) {
    run.attempt = attempt;
    const outcome = await editRunScope.run(run, apply);
    if (!changedBeforeWrite(outcome)) return outcome;
    started ??= now();
    const delay = RETRY_DELAYS_MS[attempt];
    const elapsed = now() - started;
    if (delay === undefined || elapsed + delay >= RETRY_BUDGET_MS)
      return keptChanging(outcome, attempt + 1, elapsed);
    if (delay > 0) await sleep(delay * (0.5 + Math.random()));
  }
}

const editRunScope = new AsyncLocalStorage<TextEditRun>();

/**
 * The edit whose attempt is running now: one object for all of its retries, so a resolver can
 * reuse what an earlier attempt of the same edit resolved. Undefined outside a retried edit.
 */
export function currentTextEditRun(): TextEditRun | undefined {
  return editRunScope.getStore();
}

function keptChanging<Result>(
  outcome: Extract<TextResourcesEditOutcome<Result>, { readonly kind: "failed" }>,
  attempts: number,
  elapsedMs: number,
): TextResourcesEditOutcome<Result> {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const message = `Another process kept writing the file while this edit ran: each of ${String(attempts)} attempts in ${seconds} s found newer text, so nothing was written. Repeat the edit; if it keeps failing, wait until the other writer is done.`;
  return {
    ...outcome,
    failure: {
      ...outcome.failure,
      message,
      cause: new SourceKeptChangingError(message, attempts, { cause: outcome.failure.cause }),
    },
  };
}

/** The edit wrote nothing because its source changed after it was read. */
function changedBeforeWrite<Result>(
  outcome: TextResourcesEditOutcome<Result>,
): outcome is Extract<TextResourcesEditOutcome<Result>, { readonly kind: "failed" }> {
  if (outcome.kind !== "failed" || outcome.completed.length > 0) return false;
  if ((outcome.failure.rollback?.failed.length ?? 0) > 0) return false;
  for (let cause: unknown = outcome.failure.cause; cause !== undefined;) {
    if (cause instanceof ResourceError && cause.code === "RESOURCE_CHANGED") return true;
    if (typeof cause !== "object" || cause === null) return false;
    if ((cause as { code?: unknown }).code === SOURCE_CHANGED) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}
