/** Shared protocol identifier for Pi Agent IDE startup-tip providers. */
export const TIP_PROTOCOL = "pi-agent-ide-tips" as const;

/** Current version of the startup-tip provider API. */
export const TIP_API_VERSION = 1 as const;

/** Emitted when the built-in tip core can accept providers. */
export const TIP_CORE_READY_EVENT = "pi-agent-ide-tips/core/ready" as const;

/** Emitted by providers to request registration with the tip core. */
export const TIP_PROVIDER_REGISTER_EVENT = "pi-agent-ide-tips/provider/register" as const;

/** Facts supplied to a provider for one session start. */
export interface TipContext {
  readonly cwd: string;
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly hasUI: boolean;
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";

  /** Aborted when the session ends or another startup replaces this inspection. */
  readonly signal?: AbortSignal;
}

/** One user-facing startup tip. */
export interface Tip {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** Independent provider of an optional startup tip. */
export interface TipProvider {
  readonly protocol: typeof TIP_PROTOCOL;
  readonly apiVersion: typeof TIP_API_VERSION;
  readonly id: string;
  readonly getTip: (context: TipContext) => Tip | undefined | Promise<Tip | undefined>;
}

/** Registration request sent over Pi's shared event bus. */
export interface TipProviderRegistrationRequest {
  readonly provider: TipProvider;
  accept(registration: Promise<void>): void;
}

/** Payload emitted when the tip core is ready. */
export interface TipCoreReady {
  readonly protocol: typeof TIP_PROTOCOL;
  readonly apiVersion: typeof TIP_API_VERSION;
}

/** Returns whether a value announces a compatible tip core. */
export function isTipCoreReady(value: unknown): value is TipCoreReady {
  return isRecord(value) && value.protocol === TIP_PROTOCOL && value.apiVersion === TIP_API_VERSION;
}

/** Returns whether a value is a valid tip provider registration request. */
export function isTipProviderRegistrationRequest(
  value: unknown,
): value is TipProviderRegistrationRequest {
  if (!isRecord(value) || typeof value.accept !== "function" || !isRecord(value.provider)) {
    return false;
  }

  return (
    value.provider.protocol === TIP_PROTOCOL &&
    value.provider.apiVersion === TIP_API_VERSION &&
    typeof value.provider.id === "string" &&
    value.provider.id.length > 0 &&
    typeof value.provider.getTip === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { connectTipProvider } from "./connect-tip-provider.js";
