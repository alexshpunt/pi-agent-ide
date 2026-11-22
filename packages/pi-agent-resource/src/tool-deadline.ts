import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Reservation and file-lock acquisition is separate from executing the edit. */
export const EDIT_WAIT_TIMEOUT_MS = 5_000;
export const EDIT_EXECUTION_TIMEOUT_MS = 60_000;
/** A read-only navigation request, including its startup and retries. */
export const NAVIGATION_TIMEOUT_MS = 15_000;
export const SEARCH_TIMEOUT_MS = 30_000;
/** A configured Search may extend or disable its short budget, but not this watchdog. */
const MAX_SEARCH_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Native SSH cancellation allows up to five seconds for the worker's exit receipt.
const CANCELLATION_CLEANUP_MS = 5_000;
const toolBudgets = new Map<string, number>([
  ["search", SEARCH_TIMEOUT_MS],
  ["file_search", SEARCH_TIMEOUT_MS],
  ["ast_search", SEARCH_TIMEOUT_MS],
  ["lsp_search", 20_000],
  ["diagnostics", 120_000],
  ["debug", 60_000],
  ["write", EDIT_EXECUTION_TIMEOUT_MS],
  ["replace", EDIT_EXECUTION_TIMEOUT_MS],
  ["insert", EDIT_EXECUTION_TIMEOUT_MS],
  ["delete", EDIT_EXECUTION_TIMEOUT_MS],
  ["copy", EDIT_EXECUTION_TIMEOUT_MS],
  ["move", EDIT_EXECUTION_TIMEOUT_MS],
  ["undo", EDIT_EXECUTION_TIMEOUT_MS],
]);

/** Shell tools have their own foreground-to-background transition, not a cancellation deadline. */
const shells = new Set(["bash", "powershell", "remote_bash", "remote_powershell"]);

export function ideToolTimeoutMs(tool: string): number | undefined {
  return shells.has(tool) ? undefined : (toolBudgets.get(tool) ?? DEFAULT_TIMEOUT_MS);
}

export type DeadlineEffect = "not-applied" | "applied" | "unknown";

export class ToolDeadlineError extends Error {
  readonly code = "TOOL_TIMEOUT";
  constructor(
    readonly tool: string,
    readonly target: string,
    readonly timeoutMs: number,
    readonly effect?: DeadlineEffect,
  ) {
    const action =
      effect === "applied"
        ? "The edit was applied. Reread the target before the next edit; do not repeat this one."
        : effect === "unknown"
          ? "The edit effect is unknown. Check the target before retrying."
          : effect === "not-applied"
            ? "No edit was applied. Reread the target before retrying."
            : tool === "lsp_search"
              ? "Narrow the path scope or search the text instead."
              : tool === "debug"
                ? "Check the debugger state before retrying."
                : "Narrow the path scope or retry on a responsive target.";
    super(`${tool} timed out after ${String(timeoutMs / 1000)} s on ${target}. ${action}`);
    this.name = "ToolDeadlineError";
  }
}

type Snapshot = (error: ToolDeadlineError) => AgentToolResult<unknown> | undefined;
interface ActiveDeadline {
  readonly tool: string;
  recovery?: Snapshot;
  readonly cleanup: Set<Promise<unknown>>;
  effect?: DeadlineEffect;
  readonly configure: (timeoutMs: number) => void;
}
const active = new AsyncLocalStorage<ActiveDeadline>();

/** Supply observed data only; an incomplete search must not create editable selections. */
export function snapshotOnToolDeadline(snapshot: Snapshot): void {
  const deadline = active.getStore();
  if (deadline) deadline.recovery = snapshot;
}

/** Await exit acknowledgement from a native operation, within the cancellation cleanup budget. */
export function trackToolCleanup(completion: Promise<unknown>): void {
  const deadline = active.getStore();
  deadline?.cleanup.add(completion);
  const settled = () => deadline?.cleanup.delete(completion);
  void completion.then(settled, settled);
}

/** Report a known effect at the actual mutation boundary, not the start of an editor call. */
export function reportToolEffect(effect: DeadlineEffect): void {
  const deadline = active.getStore();
  if (deadline) deadline.effect = effect;
}

/** Apply the user's Search limit to its same end-to-end deadline, measured from tool entry. */
export function configureSearchDeadline(timeoutMs: number | null): boolean {
  const deadline = active.getStore();
  if (deadline?.tool !== "search") return false;
  deadline.configure(Math.min(timeoutMs ?? MAX_SEARCH_TIMEOUT_MS, MAX_SEARCH_TIMEOUT_MS));
  return true;
}

/** End a tool call even when its owner fails to settle after receiving cancellation. */
export function runWithToolDeadline<T extends AgentToolResult<unknown>>(
  tool: string,
  target: string,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  effect: DeadlineEffect | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | AgentToolResult<unknown>> {
  return runWithinToolDeadline(
    tool,
    target,
    timeoutMs,
    parent,
    effect,
    run,
    (error, snapshot) => snapshot?.(error) ?? toolDeadlineFailure(error),
  );
}

/** Use the shared deadline for deferred tool work that has its own outcome journal. */
export async function runWithinToolDeadline<T, F>(
  tool: string,
  target: string,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  effect: DeadlineEffect | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  onTimeout: (error: ToolDeadlineError, snapshot: Snapshot | undefined) => F,
): Promise<T | F> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (value: ToolDeadlineError) => void;
  let cancel!: () => void;
  const ended = new Promise<ToolDeadlineError>((resolve, reject) => {
    finish = resolve;
    cancel = () => {
      clearTimeout(timer);
      active.run(deadline, () => controller.abort(parent?.reason));
      // Let the tool report its own cancellation outcome; end the call if it does not settle.
      timer = setTimeout(() => reject(parent?.reason), CANCELLATION_CLEANUP_MS);
    };
  });
  const deadline: ActiveDeadline = {
    tool,
    effect,
    cleanup: new Set(),
    configure(ms) {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      const expire = () => {
        const error = new ToolDeadlineError(tool, target, ms, deadline.effect);
        finish(error);
        active.run(deadline, () => controller.abort(error));
      };
      const remaining = ms - (performance.now() - started);
      if (remaining <= 0) expire();
      else timer = setTimeout(expire, Math.ceil(remaining));
    },
  };
  parent?.addEventListener("abort", cancel, { once: true });
  deadline.configure(timeoutMs);
  try {
    const result = await Promise.race([ended, active.run(deadline, () => run(controller.signal))]);
    if (!(result instanceof ToolDeadlineError)) return result;
    if (deadline.cleanup.size > 0) {
      const completions = Promise.allSettled(deadline.cleanup);
      const cleanupLimit = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CANCELLATION_CLEANUP_MS);
      });
      const cleanup = await Promise.race([completions, cleanupLimit]);
      if (cleanup === undefined || cleanup.some((entry) => entry.status === "rejected")) {
        result.message +=
          " Cancellation was sent, but native cleanup could not be confirmed. Check the target before retrying.";
      }
    }
    return onTimeout(result, deadline.recovery);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

export function toolDeadlineFailure(error: ToolDeadlineError): AgentToolResult<unknown> {
  const { code, tool, target, timeoutMs, effect, message } = error;
  return {
    content: [{ type: "text", text: message }],
    details: { code, tool, target, timeoutMs, ...(effect === undefined ? {} : { effect }) },
    isError: true,
    structuredContent: {
      status: "error",
      errors: [{ code, source: target, message }],
    },
  };
}
