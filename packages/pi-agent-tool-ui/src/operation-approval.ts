import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Versioned, synchronous request channel; decisions are returned through accept(), not the bus. */
export const OPERATION_APPROVAL_EVENT = "pi-agent-ide/operation-approval/v1";

const APPROVAL_SERVICE_EVENT = "pi-agent-ide/operation-approval/service/v1";

/** Install once per event bus, including standalone editor loading; shutdown refuses all waits. */
export function registerOperationApproval(pi: ExtensionAPI): void {
  const state = { installed: false };
  pi.events.emit(APPROVAL_SERVICE_EVENT, () => {
    state.installed = true;
  });
  if (state.installed) return;
  const service = createOperationApproval(pi.events);
  const unsubscribeRequest = pi.events.on(OPERATION_APPROVAL_EVENT, service.handle);
  const unsubscribeService = pi.events.on(APPROVAL_SERVICE_EVENT, (probe) => {
    (probe as () => void)();
  });
  pi.on("session_shutdown", () => {
    unsubscribeRequest();
    unsubscribeService();
    service.dispose();
  });
}

export interface OperationApprovalContext {
  readonly hasUI: boolean;
  readonly mode: ExtensionContext["mode"];
  readonly ui: Pick<ExtensionContext["ui"], "confirm">;
}

/** The caller owns risk classification, exact target text and the resulting one-operation permit. */
export interface OperationApprovalRequest {
  readonly title: string;
  readonly message: string;
  readonly signal?: AbortSignal;
}

interface ApprovalCall {
  readonly context: OperationApprovalContext;
  readonly request: OperationApprovalRequest;
  accept(decision: Promise<boolean>): void;
}

type Events = Pick<ExtensionAPI["events"], "emit">;

/**
 * Ask the IDE's shared service for one decision. No UI, cancellation or a missing service refuses.
 * Call only after your policy requires approval; this API does not grant or persist permissions.
 */
export async function confirmOperation(
  events: Events | undefined,
  context: OperationApprovalContext,
  request: OperationApprovalRequest,
): Promise<boolean> {
  if (!context.hasUI || request.signal?.aborted || events === undefined) return false;
  let decision: Promise<boolean> | undefined;
  events.emit(OPERATION_APPROVAL_EVENT, {
    context,
    request,
    accept(value) {
      if (decision !== undefined) throw new Error("Operation approval was accepted twice");
      decision = value;
    },
  } satisfies ApprovalCall);
  return decision === undefined ? false : decision;
}

interface Pending {
  readonly call: ApprovalCall;
  readonly controller: AbortController;
  readonly resolve: (answer: boolean) => void;
  readonly cleanup: () => void;
}

/** One session-owned queue shared by all providers, including separately loaded packages. */
export function createOperationApproval(events: Events): {
  handle(data: unknown): void;
  dispose(): void;
} {
  const queue: Pending[] = [];
  let current: Pending | undefined;
  let draining = false;
  let closed = false;
  let blocked = false;

  function setBlocked(active: boolean): void {
    if (blocked === active) return;
    blocked = active;
    try {
      events.emit(
        "herdr:blocked",
        active ? { active: true, label: "Waiting for operation approval" } : { active: false },
      );
    } catch {
      // An advisory header listener must never change a user's decision.
    }
  }

  async function drain(): Promise<void> {
    draining = true;
    while (queue.length > 0) {
      const pending = queue.shift();
      if (pending === undefined) break;
      current = pending;
      let approved = false;
      if (!closed && !pending.controller.signal.aborted) {
        setBlocked(pending.call.context.mode === "tui");
        approved = await show(pending.call, pending.controller.signal);
      }
      current = undefined;
      pending.cleanup();
      if (queue.length === 0 || queue[0]?.call.context.mode !== "tui") setBlocked(false);
      pending.resolve(approved && !closed && !pending.controller.signal.aborted);
    }
    setBlocked(false);
    draining = false;
  }

  return {
    handle(data) {
      const call = data as ApprovalCall;
      call.accept(
        new Promise<boolean>((resolve) => {
          if (closed || !call.context.hasUI || call.request.signal?.aborted) {
            resolve(false);
            return;
          }
          const controller = new AbortController();
          const cancel = (): void => {
            controller.abort();
            if (current === pending) return;
            const index = queue.indexOf(pending);
            if (index !== -1) queue.splice(index, 1);
            pending.cleanup();
            resolve(false);
          };
          const pending: Pending = {
            call,
            controller,
            resolve,
            cleanup: () => call.request.signal?.removeEventListener("abort", cancel),
          };
          call.request.signal?.addEventListener("abort", cancel, { once: true });
          queue.push(pending);
          if (!draining) void drain();
        }),
      );
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const pending of queue.splice(0)) {
        pending.controller.abort();
        pending.cleanup();
        pending.resolve(false);
      }
      current?.controller.abort();
      setBlocked(false);
    },
  };
}

function show(call: ApprovalCall, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (answer: boolean): void => {
      signal.removeEventListener("abort", abort);
      resolve(answer && !signal.aborted);
    };
    const abort = (): void => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    try {
      void call.context.ui.confirm(call.request.title, call.request.message, { signal }).then(
        // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- only an explicit yes grants permission; dismissal stays false
        (answer) => finish(answer === true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
