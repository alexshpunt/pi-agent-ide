import { AgentSession } from "@earendil-works/pi-coding-agent";

type SteeringObserver = (session: AgentSession) => void;
const observersKey = Symbol.for("pi-agent-ide.terminal-steering-observers");
interface SteeringObservers {
  readonly listeners: Set<SteeringObserver>;
  readonly restore: () => void;
}
type ObservedPrototype = typeof AgentSession.prototype & {
  [observersKey]?: SteeringObservers;
};

/** Observe accepted user steering after Pi queues it, without bypassing its input handlers. */
export function observeQueuedSteering(observer: SteeringObserver): () => void {
  const prototype = AgentSession.prototype as ObservedPrototype;
  const observers = prototype[observersKey] ?? installObservers(prototype);
  observers.listeners.add(observer);
  return () => {
    observers.listeners.delete(observer);
    if (observers.listeners.size === 0) observers.restore();
  };
}

function installObservers(prototype: ObservedPrototype): SteeringObservers {
  const originalPrompt = prototype.prompt;
  const originalSteer = prototype.steer;
  const listeners = new Set<SteeringObserver>();
  const notify = (session: AgentSession): void => {
    for (const listener of [...listeners]) listener(session);
  };

  // TUI Enter calls prompt, while RPC and queue editing call steer directly.
  // The preflight hook runs after queue insertion and distinguishes consumed input.
  const prompt: AgentSession["prompt"] = function (this: AgentSession, text, options) {
    if (options?.streamingBehavior !== "steer") return originalPrompt.call(this, text, options);
    return originalPrompt.call(this, text, {
      ...options,
      preflightResult: (disposition) => {
        options.preflightResult?.(disposition);
        if (disposition === "queued") notify(this);
      },
    });
  };
  const steer: AgentSession["steer"] = async function (this: AgentSession, ...args) {
    const disposition = await originalSteer.apply(this, args);
    if (disposition === "queued") notify(this);
    return disposition;
  };
  prototype.prompt = prompt;
  prototype.steer = steer;
  const observers: SteeringObservers = {
    listeners,
    restore: () => {
      if (prototype[observersKey] !== observers) return;
      if (prototype.prompt === prompt) prototype.prompt = originalPrompt;
      if (prototype.steer === steer) prototype.steer = originalSteer;
      delete prototype[observersKey];
    },
  };
  prototype[observersKey] = observers;
  return observers;
}
