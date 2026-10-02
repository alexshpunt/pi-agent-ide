import { AsyncLocalStorage } from "node:async_hooks";

/** One canonical resource touched by an operation. Writes conflict with reads and writes. */
export interface ResourceAccess {
  /** Canonical identity, or * for an unknown read scope. */
  readonly resource: string;
  /** Alternative identities of one resource share a group. */
  readonly group?: string;
  readonly mode: "read" | "write";
  /** Include descendants of a canonical directory key. */
  readonly recursive?: boolean;
}

interface ActiveReservation {
  readonly accesses: readonly ResourceAccess[] | undefined;
  readonly children: Set<Promise<unknown>>;
  readonly allowNestedWrites: boolean;
  nested?: ResourceScheduler;
  open: boolean;
}

interface ScheduledOperation {
  readonly accesses: Promise<readonly ResourceAccess[] | undefined>;
  readonly done: Promise<void>;
}
interface SchedulerState {
  readonly pending: Set<ScheduledOperation>;
  readonly active: AsyncLocalStorage<ActiveReservation>;
}

function createSchedulerState(): SchedulerState {
  return { pending: new Set(), active: new AsyncLocalStorage<ActiveReservation>() };
}

function conflicts(
  left: readonly ResourceAccess[] | undefined,
  right: readonly ResourceAccess[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  return left.some((a) =>
    right.some(
      (b) =>
        (a.mode === "write" || b.mode === "write") &&
        (a.resource === "*" ||
          b.resource === "*" ||
          a.resource === b.resource ||
          (a.recursive === true &&
            b.resource.startsWith(a.resource.endsWith("/") ? a.resource : `${a.resource}/`)) ||
          (b.recursive === true &&
            a.resource.startsWith(b.resource.endsWith("/") ? b.resource : `${b.resource}/`))),
    ),
  );
}

function coveredAccess(
  held: readonly ResourceAccess[] | undefined,
  requested: readonly ResourceAccess[] | undefined,
  allowWrites: boolean,
): boolean {
  if (
    requested === undefined ||
    (!allowWrites && requested.some((access) => access.mode !== "read"))
  )
    return false;
  if (held === undefined) return true;
  const groups = new Map<string, ResourceAccess[]>();
  for (const access of requested) {
    const group = access.group ?? access.resource;
    groups.set(group, [...(groups.get(group) ?? []), access]);
  }
  return [...groups.values()].every((identities) =>
    identities.some((access) =>
      held.some(
        (owner) =>
          (access.mode === "read" || owner.mode === "write") &&
          (owner.resource === "*" ||
            (access.resource === owner.resource &&
              (access.recursive !== true || owner.recursive === true)) ||
            (owner.recursive === true &&
              access.resource.startsWith(
                owner.resource.endsWith("/") ? owner.resource : `${owner.resource}/`,
              ))),
      ),
    ),
  );
}
async function waitForDependencies<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return await pending;
  }
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/**
 * Run disjoint operations together and preserve submission order for conflicts.
 * Callers supply complete canonical resource sets before touching their contents.
 * An unknown set is exclusive. Async resolution reserves submission order.
 */
export class ResourceScheduler {
  /** Create an isolated scheduler, or share reservation state across module loaders. */
  constructor(private readonly state: SchedulerState = createSchedulerState()) {}

  /** Reserve the full access set until the action and its nested children settle.
   * Cancel queued work with signal; active actions must observe cancellation themselves.
   * Permit nested writes only for an owner that already reserves every affected resource.
   */
  run<T>(
    accesses:
      | readonly ResourceAccess[]
      | undefined
      | Promise<readonly ResourceAccess[] | undefined>,
    action: () => T | Promise<T>,
    signal?: AbortSignal,
    ownership: { readonly allowNestedWrites?: boolean } = {},
  ): Promise<T> {
    const resolved = Promise.resolve(accesses);
    const parent = this.state.active.getStore();
    if (parent?.open) {
      const validated = resolved.then((current) => {
        signal?.throwIfAborted();
        if (!coveredAccess(parent.accesses, current, parent.allowNestedWrites))
          throw Object.assign(
            new Error(
              "Nested resource access must be covered by its parent reservation and permitted by its owner.",
            ),
            { code: "UNDECLARED_RESOURCE_ACCESS" },
          );
        return current;
      });
      parent.nested ??= new ResourceScheduler();
      const child = parent.nested.run(validated, action, signal, {
        allowNestedWrites: parent.allowNestedWrites,
      });
      parent.children.add(child);
      void child.then(
        () => parent.children.delete(child),
        () => parent.children.delete(child),
      );
      return child;
    }
    const prior = [...this.state.pending];
    // A failed resolution is exclusive until the operation reports that failure.
    const safeAccesses = resolved.catch(() => undefined);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { accesses: safeAccesses, done };
    this.state.pending.add(entry);
    return (async () => {
      try {
        signal?.throwIfAborted();
        const current = await waitForDependencies(
          resolved.then(async (current) => {
            await Promise.all(
              prior.map((previous) =>
                Promise.race([
                  previous.done,
                  previous.accesses.then((accesses) =>
                    conflicts(current, accesses) ? previous.done : undefined,
                  ),
                ]),
              ),
            );
            return current;
          }),
          signal,
        );
        signal?.throwIfAborted();
        const reservation: ActiveReservation = {
          accesses: current,
          children: new Set(),
          open: true,
          allowNestedWrites: ownership.allowNestedWrites === true,
        };
        try {
          return await this.state.active.run(reservation, action);
        } finally {
          while (reservation.children.size > 0) await Promise.allSettled([...reservation.children]);
          reservation.open = false;
        }
      } finally {
        this.state.pending.delete(entry);
        finish();
      }
    })();
  }
}

const sharedStateKey = Symbol.for("pi-agent-resource.resource-scheduler-state");
const host = globalThis as typeof globalThis & { [sharedStateKey]?: SchedulerState };
const sharedState = (host[sharedStateKey] ??= createSchedulerState());

/** Shared reservations across extension module loaders; reloading uses fresh scheduler code. */
export const resourceScheduler = new ResourceScheduler(sharedState);
