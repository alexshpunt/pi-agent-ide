import { ResourceError } from "pi-agent-resource";

import type { TextResourcesEditOutcome } from "#src/core/text-editor-core.ts";

/** Error code of a resolved target whose file changed before the edit used it. */
export const SOURCE_CHANGED = "SOURCE_CHANGED";

/**
 * Pauses before each new attempt while other processes keep writing the file. Random spread
 * keeps several waiting processes from colliding again at the same moment.
 */
const RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800, 1600];

/**
 * Another Pi process may write the file between an edit's read and its write. The write is then
 * refused, and the edit runs again on the current text, anchors included.
 */
export async function retryWhenSourceChanged<Result>(
  apply: () => Promise<TextResourcesEditOutcome<Result>>,
): Promise<TextResourcesEditOutcome<Result>> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await apply();
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !changedBeforeWrite(outcome)) return outcome;
    if (delay > 0)
      await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())));
  }
}

/** The edit wrote nothing because its source changed after it was read. */
function changedBeforeWrite(outcome: TextResourcesEditOutcome<unknown>): boolean {
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
