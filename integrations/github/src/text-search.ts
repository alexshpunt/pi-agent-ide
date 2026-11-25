import { Worker } from "node:worker_threads";
import type { ResultRange } from "pi-agent-ide/api/resource";
import type { SearchContext, SearchSelectionMatch } from "pi-agent-ide/api/search";

export interface TextSearchWork {
  readonly source: string;
  readonly content: string;
  readonly pattern: string;
  readonly flags: string;
  readonly maximum: number;
  readonly scope?: {
    readonly targets: readonly {
      readonly source: string;
      readonly ranges: readonly Pick<ResultRange, "start" | "end">[];
    }[];
  };
}

/** Run one bounded text match off the agent event loop; timeout never means no matches. */
export async function matchText(
  source: string,
  content: string,
  pattern: RegExp,
  maximum: number,
  context: SearchContext,
): Promise<SearchSelectionMatch[]> {
  const { signal } = context;
  signal?.throwIfAborted();
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("GH_TEXT_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const workerData: TextSearchWork = {
      source,
      content,
      pattern: pattern.source,
      flags: pattern.flags,
      maximum,
      scope: context.scope
        ? {
            targets: context.scope.targets.map((target) => ({
              source: target.source,
              ranges: target.ranges.map((range) => ({
                start: { lineNumber: range.start.lineNumber, column: range.start.column },
                end: { lineNumber: range.end.lineNumber, column: range.end.column },
              })),
            })),
          }
        : undefined,
    };
    const worker = new Worker(new URL("./text-worker.mjs", import.meta.url), { workerData });
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      settle();
    };
    const abort = () => finish(() => reject(signal?.reason));
    const fail = () => finish(() => reject(new Error("GH_TEXT_SEARCH_FAILED")));
    const timer = setTimeout(() => finish(() => reject(new Error("GH_TEXT_SEARCH_TIMEOUT"))), 2000);
    signal?.addEventListener("abort", abort, { once: true });
    // The sibling worker sends only SearchSelectionMatch[] on this private channel.
    worker.once("message", (matches: unknown) =>
      finish(() => resolve(matches as SearchSelectionMatch[])),
    );
    worker.once("error", fail);
    worker.once("exit", fail);
    if (signal?.aborted) abort();
  });
}
