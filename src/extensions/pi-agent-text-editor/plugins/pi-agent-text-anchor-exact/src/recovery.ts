import { Worker } from "node:worker_threads";

import type {
  TextAnchorRecoveryCandidate,
  TextAnchorRecoveryOutcome,
  TextAnchorResolverRecoveryContext,
} from "pi-agent-text";

import { findExactTextMatches } from "./anchor.js";
import type { ExactTextRecoveryConfig } from "./config.js";
import { FUZZY_WORKER_SOURCE } from "./fuzzy-worker.js";

interface RankedBlock {
  readonly startLine: number;
  readonly endLine: number;
}

interface WorkerMessage {
  readonly kind: "ready" | "result" | "failed";
  readonly blocks?: readonly RankedBlock[];
  readonly message?: string;
}

/** Returns safe exact or fuzzy candidates for a rejected Exact text anchor. */
export async function recoverExactText(
  value: string,
  context: TextAnchorResolverRecoveryContext,
  config: ExactTextRecoveryConfig,
): Promise<TextAnchorRecoveryOutcome> {
  if (context.rejection.code === "ambiguous") {
    const matches = findExactTextMatches(value, context, config.exactCandidateLimit);
    return {
      kind: "candidates",
      total: matches.total,
      candidates: matches.ranges.map((range, index) => ({ rank: index + 1, range })),
    };
  }

  if (context.rejection.code !== "missing" || !canSearch(value, context.content, config)) {
    return { kind: "unavailable" };
  }
  if (context.signal !== undefined && context.signal.aborted) {
    return { kind: "failed", error: context.signal.reason };
  }

  const outcome = await runFuzzyWorker(value, context.lines, config, context.signal);
  if (outcome.kind !== "blocks") {
    return outcome.outcome;
  }
  const candidates: TextAnchorRecoveryCandidate[] = [];
  for (const [index, block] of outcome.blocks.entries()) {
    const endLine = context.lines[block.endLine - 1];
    if (endLine === undefined) {
      return { kind: "failed", error: new Error("Fuzzy Worker returned an invalid source range") };
    }
    candidates.push({
      rank: index + 1,
      range: {
        start: { lineNumber: block.startLine, column: 0 },
        end: { lineNumber: block.endLine, column: endLine.length },
      },
    });
  }
  return { kind: "candidates", candidates, total: candidates.length };
}

function canSearch(value: string, content: string, config: ExactTextRecoveryConfig): boolean {
  if (!config.fuzzyEnabled || value.replace(/\s/gu, "").length < 4) {
    return false;
  }
  const encoder = new TextEncoder();
  return (
    encoder.encode(value).byteLength <= config.maxQuerySizeKiB * 1024 &&
    encoder.encode(content).byteLength <= config.maxFileSizeMiB * 1024 * 1024
  );
}

type WorkerOutcome =
  | { readonly kind: "blocks"; readonly blocks: readonly RankedBlock[] }
  | { readonly kind: "outcome"; readonly outcome: TextAnchorRecoveryOutcome };

function runFuzzyWorker(
  value: string,
  sourceLines: readonly string[],
  config: ExactTextRecoveryConfig,
  signal: AbortSignal | undefined,
): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(FUZZY_WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: import.meta.resolve("fast-fuzzy"),
        value,
        sourceLines,
        config,
      },
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: WorkerOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal !== undefined) {
        signal.removeEventListener("abort", abort);
      }
      void worker.terminate();
      resolve(outcome);
    };
    const abort = (): void => {
      if (signal !== undefined) {
        finish({ kind: "outcome", outcome: { kind: "failed", error: signal.reason } });
      }
    };

    if (signal !== undefined) {
      signal.addEventListener("abort", abort, { once: true });
    }
    worker.on("error", (error) => finish({ kind: "outcome", outcome: { kind: "failed", error } }));
    worker.on("message", (message: WorkerMessage) => {
      if (message.kind === "ready") {
        timer = setTimeout(
          () => finish({ kind: "outcome", outcome: { kind: "timed-out" } }),
          config.timeoutMs,
        );
        worker.postMessage("search", []);
        return;
      }
      if (message.kind === "failed") {
        finish({
          kind: "outcome",
          outcome: { kind: "failed", error: new Error(message.message ?? "Fuzzy Worker failed") },
        });
        return;
      }
      if (message.blocks === undefined) {
        finish({
          kind: "outcome",
          outcome: { kind: "failed", error: new Error("Fuzzy Worker omitted result blocks") },
        });
        return;
      }
      finish({ kind: "blocks", blocks: message.blocks });
    });
  });
}
