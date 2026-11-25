import { Worker } from "node:worker_threads";
import { isAgentContent, type AgentContent } from "pi-agent-ide/api/resource";
import type { AssetConversionRequest } from "./asset-worker.ts";

const TIMEOUT_MS = 120_000;
const IDLE_MS = 60_000;
const MAX_BYTES = 25 * 1024 * 1024;

interface Job {
  readonly source: string;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
  readonly resolve: (content: AgentContent | undefined) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The shared binary converters run in a worker thread with its own module state and memory
 * limit, so a parser crash or runaway allocation cannot reach Pi. Loading the converters
 * takes seconds, because their module graph includes the whole Pi package, so one worker
 * stays loaded and converts files one at a time. It is replaced after a conversion that timed
 * out, was cancelled, crashed it or returned content outside the contract, and it exits
 * after a minute without work.
 */
let worker: Worker | undefined;
let idle: NodeJS.Timeout | undefined;
let active: { readonly job: Job; readonly id: number; readonly cleanup: () => void } | undefined;
let nextId = 1;
const queue: Job[] = [];

function stopWorker(): void {
  clearTimeout(idle);
  void worker?.terminate();
  worker = undefined;
}

function startWorker(): Worker {
  const started = new Worker(new URL("./asset-worker.ts", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  started.on("message", (reply: unknown) => {
    if (started !== worker || !active || !reply || typeof reply !== "object") return;
    const { id, ok, content } = reply as { id?: unknown; ok?: unknown; content?: unknown };
    if (id !== active.id) return;
    // A file the converters reject is an ordinary result; the worker stays loaded.
    if (ok !== true) settle(new Error("LINEAR_ASSET_FORMAT_UNSUPPORTED"), undefined, true);
    // Content outside the contract means the worker itself is not trusted any more.
    else if (
      content !== undefined &&
      (!isAgentContent(content) || Buffer.byteLength(JSON.stringify(content)) > MAX_BYTES)
    )
      settle(new Error("LINEAR_ASSET_FORMAT_UNSUPPORTED"));
    else settle(undefined, content, true);
  });
  const lost = () => {
    if (started !== worker) return;
    worker = undefined;
    settle(new Error("LINEAR_ASSET_FORMAT_UNSUPPORTED"), undefined, true);
  };
  started.on("error", lost);
  started.on("exit", lost);
  return started;
}

/** Finish the running conversion; the worker is replaced unless it converted cleanly. */
function settle(error?: Error, content?: AgentContent, keepWorker = false): void {
  const current = active;
  if (!current) return;
  active = undefined;
  current.cleanup();
  if (!keepWorker) stopWorker();
  if (error) current.job.reject(error);
  else current.job.resolve(content);
  next();
}

function next(): void {
  if (active) return;
  let job: Job | undefined;
  while ((job = queue.shift()) && job.signal?.aborted)
    job.reject(new Error("LINEAR_ASSET_READ_CANCELLED"));
  if (!job) {
    if (worker) {
      // Pi may exit while the converters stay loaded for the next Read.
      worker.unref();
      clearTimeout(idle);
      idle = setTimeout(stopWorker, IDLE_MS);
      idle.unref();
    }
    return;
  }
  clearTimeout(idle);
  worker ??= startWorker();
  worker.ref();
  const id = nextId++;
  const abort = () => settle(new Error("LINEAR_ASSET_READ_CANCELLED"));
  const timer = setTimeout(() => settle(new Error("LINEAR_ASSET_FORMAT_TIMEOUT")), TIMEOUT_MS);
  job.signal?.addEventListener("abort", abort, { once: true });
  active = {
    job,
    id,
    cleanup: () => {
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", abort);
    },
  };
  const request: AssetConversionRequest = { id, source: job.source, bytes: job.bytes };
  worker.postMessage(request, []);
}

/** Run the shared binary converters with isolated module state and bounded lifetime/output. */
export async function convertAsset(
  source: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AgentContent | undefined> {
  signal?.throwIfAborted();
  if (bytes.byteLength > MAX_BYTES) throw new Error("LINEAR_ASSET_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const job: Job = { source, bytes, signal, resolve, reject };
    // A queued conversion that is cancelled before it starts leaves the queue at once.
    signal?.addEventListener(
      "abort",
      () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new Error("LINEAR_ASSET_READ_CANCELLED"));
      },
      { once: true },
    );
    queue.push(job);
    next();
  });
}
