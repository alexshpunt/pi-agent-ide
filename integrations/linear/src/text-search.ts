import { Worker } from "node:worker_threads";
import type { SearchContext, SearchSelectionMatch } from "pi-agent-ide/api/search";
import type { TextMatchRequest } from "./text-worker.ts";

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
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("LINEAR_TEXT_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const request: TextMatchRequest = {
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
    const worker = new Worker(new URL("./text-worker.ts", import.meta.url), {
      workerData: request,
    });
    let done = false;
    const finish = (outcome: { error: unknown } | { matches: SearchSelectionMatch[] }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.matches);
    };
    const abort = () => {
      const error: unknown = signal?.reason;
      finish({ error });
    };
    const timer = setTimeout(
      () => finish({ error: new Error("LINEAR_TEXT_SEARCH_TIMEOUT") }),
      2000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (matches: SearchSelectionMatch[]) => finish({ matches }));
    worker.once("error", () => finish({ error: new Error("LINEAR_TEXT_SEARCH_FAILED") }));
    worker.once("exit", () => {
      if (!done) finish({ error: new Error("LINEAR_TEXT_SEARCH_FAILED") });
    });
    if (signal?.aborted) abort();
  });
}
