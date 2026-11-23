export interface RejectionGuardOptions {
  /** Identity of the installer; installing the same ID again, as after a Pi reload, replaces it. */
  readonly id: string;
  /** Whether this rejection comes from the installer's code. */
  readonly owns: (reason: unknown) => boolean;
  /** Called instead of crashing for an owned rejection. */
  readonly report: (reason: unknown) => void;
}

interface Handler {
  readonly owns: (reason: unknown) => boolean;
  readonly report: (reason: unknown) => void;
}

interface Registry {
  readonly handlers: Map<string, Handler>;
  readonly listener: (reason: unknown) => void;
}

const REGISTRY = Symbol.for("pi-problem-report.rejection-guard");

type GlobalWithRegistry = typeof globalThis & { [REGISTRY]?: Registry };

/** The error Node raises for a rejection no listener handles. */
function unhandledError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  let text: string;
  try {
    text = typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    text = typeof reason;
  }
  return Object.assign(
    new Error(
      `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${text}".`,
    ),
    { code: "ERR_UNHANDLED_REJECTION" },
  );
}

function createRegistry(): Registry {
  const handlers = new Map<string, Handler>();
  const listener = (reason: unknown): void => {
    for (const handler of handlers.values()) {
      let owned = false;
      try {
        owned = handler.owns(reason);
      } catch {
        // An undecidable rejection is not ours.
      }
      if (!owned) continue;
      try {
        handler.report(reason);
      } catch {
        // Reporting a problem must never cause another one.
      }
      return;
    }
    // Another listener decides what happens to rejections that are not ours.
    if (process.listenerCount("unhandledRejection") > 1) return;
    // Without other listeners, keep Node's default: the rejection ends the process.
    throw unhandledError(reason);
  };
  return { handlers, listener };
}

/**
 * Report unhandled promise rejections from an extension's own code instead of letting them end
 * Pi. Every installer in the process shares one `unhandledRejection` listener. A rejection no
 * installer owns still ends the process as before, unless another listener handles it.
 * Returns a function that removes this installer.
 */
export function installRejectionGuard(options: RejectionGuardOptions): () => void {
  const global = globalThis as GlobalWithRegistry;
  let registry = global[REGISTRY];
  if (!registry) {
    registry = createRegistry();
    global[REGISTRY] = registry;
    process.on("unhandledRejection", registry.listener);
  }
  const handler: Handler = { owns: options.owns, report: options.report };
  registry.handlers.set(options.id, handler);
  const installed = registry;
  return () => {
    if (installed.handlers.get(options.id) !== handler) return;
    installed.handlers.delete(options.id);
    if (installed.handlers.size > 0) return;
    process.off("unhandledRejection", installed.listener);
    if (global[REGISTRY] === installed) delete global[REGISTRY];
  };
}
