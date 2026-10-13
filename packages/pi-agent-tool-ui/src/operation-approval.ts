import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Versioned synchronous channel; decisions return through accept(), not the bus. */
export const OPERATION_APPROVAL_EVENT = "pi-agent-ide/operation-approval/v1";
/** Non-context branch entry recording a user-selected session permission. */
export const OPERATION_PERMISSION_ENTRY = "pi-agent-ide/operation-permission/v1";
const APPROVAL_SERVICE_EVENT = "pi-agent-ide/operation-approval/service/v1";

export interface OperationApprovalContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly mode: ExtensionContext["mode"];
  readonly ui: Pick<ExtensionContext["ui"], "select">;
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getBranch">;
}

/** The caller owns risk classification, category identity, target text and its one-operation permit. */
export interface OperationApprovalRequest {
  /** Stable extension identity; permissions never cross owners. */
  readonly owner: string;
  /** Stable dialog category, independent of the target path or URL. */
  readonly category: string;
  /** Registered boolean setting used by the host's persistent YOLO policy. */
  readonly yoloSetting?: string;
  readonly title: string;
  readonly message: string;
  readonly signal?: AbortSignal;
}

/** Host policy is separate from the provider's technical guards and from session grants. */
export interface OperationApprovalOptions {
  readonly isAllowed?: (
    request: OperationApprovalRequest,
    context: OperationApprovalContext,
  ) => Promise<boolean>;
  readonly remember?: (request: OperationApprovalRequest) => void;
}

interface ApprovalCall {
  readonly context: OperationApprovalContext;
  readonly request: OperationApprovalRequest;
  accept(decision: Promise<boolean>): void;
}
type Events = Pick<ExtensionAPI["events"], "emit">;
interface ApprovalService {
  handle(data: unknown): void;
  setPolicy(policy: OperationApprovalOptions["isAllowed"]): void;
  dispose(): void;
}

/** Install once per event bus; a later IDE host can attach policy to a standalone editor's service. */
export function registerOperationApproval(
  pi: ExtensionAPI,
  options: Pick<OperationApprovalOptions, "isAllowed"> = {},
): void {
  let installed: ApprovalService | undefined;
  pi.events.emit(APPROVAL_SERVICE_EVENT, (service: ApprovalService) => {
    installed = service;
  });
  if (installed !== undefined) {
    if (options.isAllowed !== undefined) installed.setPolicy(options.isAllowed);
    return;
  }
  const service = createOperationApproval(pi.events, {
    ...options,
    remember: (request) =>
      pi.appendEntry(OPERATION_PERMISSION_ENTRY, {
        owner: request.owner,
        category: request.category,
      }),
  });
  const unsubscribeRequest = pi.events.on(OPERATION_APPROVAL_EVENT, service.handle);
  const unsubscribeService = pi.events.on(APPROVAL_SERVICE_EVENT, (probe) => {
    (probe as (value: ApprovalService) => void)(service);
  });
  pi.on("session_shutdown", () => {
    unsubscribeRequest();
    unsubscribeService();
    service.dispose();
  });
}

/** Request permission through the shared service. Missing service and cancellation refuse. */
export async function confirmOperation(
  events: Events | undefined,
  context: OperationApprovalContext,
  request: OperationApprovalRequest,
): Promise<boolean> {
  if (request.signal?.aborted || events === undefined) return false;
  if (!request.owner.trim() || !request.category.trim())
    throw new Error("Approval owner and category are required");
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

/** One session-owned queue. Each request reads only the current branch's remembered grants. */
export function createOperationApproval(
  events: Events,
  options: OperationApprovalOptions = {},
): ApprovalService {
  const queue: Pending[] = [];
  let current: Pending | undefined;
  let draining = false;
  let closed = false;
  let blocked = false;
  let isAllowed = options.isAllowed;

  function setBlocked(active: boolean): void {
    if (blocked === active) return;
    blocked = active;
    try {
      events.emit(
        "herdr:blocked",
        active ? { active: true, label: "Waiting for operation approval" } : { active: false },
      );
    } catch {
      // Advisory header listeners must never change permission.
    }
  }

  function remembered(call: ApprovalCall): boolean {
    return (
      call.context.sessionManager?.getBranch().some((entry) => {
        if (entry.type !== "custom" || entry.customType !== OPERATION_PERMISSION_ENTRY)
          return false;
        const data = entry.data as { owner?: unknown; category?: unknown } | null;
        return data?.owner === call.request.owner && data.category === call.request.category;
      }) ?? false
    );
  }

  function active(pending: Pending): boolean {
    return !closed && !pending.controller.signal.aborted;
  }
  async function drain(): Promise<void> {
    draining = true;
    while (queue.length > 0) {
      const pending = queue.shift();
      if (pending === undefined) break;
      current = pending;
      let approved = false;
      try {
        if (active(pending)) {
          const call = pending.call;
          approved = remembered(call);
          if (!approved && isAllowed !== undefined) {
            const policy = isAllowed;
            approved =
              (await untilCancelled(pending.controller.signal, () =>
                policy(call.request, call.context),
              )) === true;
          }
          if (!approved && call.context.hasUI && active(pending)) {
            setBlocked(call.context.mode === "tui");
            const canRemember =
              options.remember !== undefined && call.context.sessionManager !== undefined;
            const answer = await show(call, pending.controller.signal, canRemember);
            approved = answer === "Allow once" || answer === "Allow for session";
            if (answer === "Allow for session" && active(pending)) {
              options.remember?.(call.request);
            }
          }
        }
      } catch {
        // A failed policy, session write or dialog cannot grant permission or strand the queue.
        approved = false;
      }
      current = undefined;
      pending.cleanup();
      setBlocked(false);
      pending.resolve(approved && active(pending));
    }
    setBlocked(false);
    draining = false;
  }

  return {
    setPolicy(policy) {
      isAllowed = policy;
    },
    handle(data) {
      const call = data as ApprovalCall;
      call.accept(
        new Promise<boolean>((resolve) => {
          if (closed || call.request.signal?.aborted) {
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

function show(
  call: ApprovalCall,
  signal: AbortSignal,
  canRemember: boolean,
): Promise<string | undefined> {
  const title = `${call.request.title}\n${call.request.message}\nScope: ${call.request.owner} / ${call.request.category}\nDisable confirmations in /agent-ide-settings (YOLO).`;
  const choices = ["Deny", "Allow once", ...(canRemember ? ["Allow for session"] : [])];
  return untilCancelled(signal, () => call.context.ui.select(title, choices, { signal }));
}

function untilCancelled<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const finish = (answer?: T): void => {
      signal.removeEventListener("abort", abort);
      resolve(signal.aborted ? undefined : answer);
    };
    const abort = (): void => finish();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    const fail = (error: unknown): void => {
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    try {
      void action().then(finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}
