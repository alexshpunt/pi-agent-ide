import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AxiError } from "#axi/args.ts";
import { rateLimitInfoFromError, type RateLimitInfo } from "#axi/rate-limit.ts";
import { asArrayOfUnknown } from "#axi/types.ts";

/** Closed stages in the resource adapter; no backend text becomes a stage or reason. */
export type ResourceFailureStage = "CAPABILITIES" | "WORKSPACE" | "OPERATION" | "ISSUE_ENRICHMENT";
/** Allowlisted causes whose names may be shown without private backend diagnostics. */
export type ResourceFailureReason =
  | "AUTH_REQUIRED"
  | "NATIVE_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "CONNECTION_REMOVED"
  | "CONNECTION_CHANGED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CONNECTION_FAILED"
  | "CONNECT_FAILED"
  | "ISSUE_NOT_FOUND"
  | "BACKEND_REJECTED"
  | "VALIDATION_FAILED"
  | "INVALID_RESPONSE"
  | "IDENTITY_MISMATCH"
  | "CANCELLED"
  | "UNKNOWN";

const stageDescriptions: Record<ResourceFailureStage, string> = {
  CAPABILITIES: "fetching the available operations",
  WORKSPACE: "checking the workspace",
  OPERATION: "requesting the resource",
  ISSUE_ENRICHMENT: "reading additional issue fields",
};
const reasonDescriptions: Record<ResourceFailureReason, string> = {
  AUTH_REQUIRED: "Linear authorization is required.",
  NATIVE_UNAVAILABLE:
    "This connection cannot use the native API. Select a suitable saved connection with /linear switch, or add an API key/own-app OAuth connection.",
  STORAGE_UNAVAILABLE:
    "This connection cannot access private files. Select a suitable saved connection with /linear switch.",
  CONNECTION_REMOVED:
    "The selected saved connection was removed. Select another with /linear switch; no automatic fallback.",
  CONNECTION_CHANGED:
    "The selected connection changed during the request. Read again under the intended connection; the request was not replayed.",
  PERMISSION_DENIED: "Linear denied access.",
  RATE_LIMITED: "Linear rate-limited the request.",
  TIMEOUT: "The request timed out.",
  CONNECTION_FAILED: "The connection failed.",
  CONNECT_FAILED: "Could not open a connection to Linear.",
  ISSUE_NOT_FOUND:
    "Linear could not find the referenced issue. Check the issue identifier and connection access.",
  BACKEND_REJECTED: "The backend reported a tool error; its underlying cause is unknown.",
  VALIDATION_FAILED:
    "Linear rejected the request as invalid. Check the submitted fields against the current schema and allowed values.",
  INVALID_RESPONSE: "The backend returned an invalid response.",
  IDENTITY_MISMATCH: "The returned workspace or resource did not match the request.",
  CANCELLED: "The request was cancelled.",
  UNKNOWN: "The backend did not provide a recognized safe cause.",
};
function description(stage: ResourceFailureStage, reason: ResourceFailureReason): string {
  return `Linear request failed while ${stageDescriptions[stage]}. ${reasonDescriptions[reason]} Do not retry automatically.`;
}

/**
 * A failure to open the TCP connection, before any request byte was written.
 * Node marks connect and DNS errors with their syscall; happy-eyeballs (autoSelectFamily)
 * reports one AggregateError after every address attempt failed to connect.
 */
export function isConnectPhaseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as Error & { code?: unknown; syscall?: unknown };
  if (code === "UND_ERR_CONNECT_TIMEOUT" || syscall === "connect" || syscall === "getaddrinfo")
    return true;
  const causes = error instanceof AggregateError ? asArrayOfUnknown(error.errors) : undefined;
  return (
    causes !== undefined &&
    causes.length > 0 &&
    causes.every((item) => item !== error && isConnectPhaseFailure(item))
  );
}

/** Describe only closed resource error codes; arbitrary exception text is never rendered. */
export function resourceFailureDescription(code: string): string | undefined {
  for (const stage of Object.keys(stageDescriptions) as ResourceFailureStage[]) {
    const prefix = `LINEAR_${stage}_`;
    if (!code.startsWith(prefix)) continue;
    const reason = code.slice(prefix.length);
    if (Object.hasOwn(reasonDescriptions, reason))
      return description(stage, reason as ResourceFailureReason);
  }
}

const internalReasons = new Map<string, ResourceFailureReason>([
  ["LINEAR_GRAPHQL_AUTH_REQUIRED", "AUTH_REQUIRED"],
  ["LINEAR_AUTH_NATIVE_UNAVAILABLE", "NATIVE_UNAVAILABLE"],
  ["LINEAR_AUTH_STORAGE_UNAVAILABLE", "STORAGE_UNAVAILABLE"],
  ["LINEAR_AUTH_CONNECTION_REMOVED", "CONNECTION_REMOVED"],
  ["LINEAR_AUTH_CONTEXT_CHANGED", "CONNECTION_CHANGED"],
  ["LINEAR_AUTH_REQUIRED", "AUTH_REQUIRED"],
  ["LINEAR_AUTH_EXPIRED", "AUTH_REQUIRED"],
  ["LINEAR_PERMISSION_DENIED", "PERMISSION_DENIED"],
  ["LINEAR_RATE_LIMITED", "RATE_LIMITED"],
  ["LINEAR_INVALID_RESPONSE", "INVALID_RESPONSE"],
  ["LINEAR_GRAPHQL_FAILED", "BACKEND_REJECTED"],
  ["LINEAR_SCHEMA_INVALID", "INVALID_RESPONSE"],
  ["LINEAR_IDENTITY_MISMATCH", "IDENTITY_MISMATCH"],
]);
const transportReasons = new Map<string, ResourceFailureReason>([
  ["ETIMEDOUT", "TIMEOUT"],
  ["ESOCKETTIMEDOUT", "TIMEOUT"],
  ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"],
  ["UND_ERR_HEADERS_TIMEOUT", "TIMEOUT"],
  ["UND_ERR_BODY_TIMEOUT", "TIMEOUT"],
  ["ECONNREFUSED", "CONNECTION_FAILED"],
  ["ECONNRESET", "CONNECTION_FAILED"],
  ["ENOTFOUND", "CONNECTION_FAILED"],
  ["EAI_AGAIN", "CONNECTION_FAILED"],
  ["ENETUNREACH", "CONNECTION_FAILED"],
  ["EHOSTUNREACH", "CONNECTION_FAILED"],
  ["EPIPE", "CONNECTION_FAILED"],
  ["UND_ERR_SOCKET", "CONNECTION_FAILED"],
  ["ABORT_ERR", "CANCELLED"],
]);

/** A public safe code. Private exception messages and responses are deliberately not retained. */
// Safe server timing is protocol data; private exception text is never forwarded.
export class ResourceOperationFailure extends AxiError {
  readonly rateLimit?: RateLimitInfo;
  readonly stage: ResourceFailureStage;
  readonly reason: ResourceFailureReason;
  readonly effect?: "applied" | "not-applied" | "unknown";
  constructor(
    stage: ResourceFailureStage,
    reason: ResourceFailureReason,
    rateLimit?: RateLimitInfo,
    effect?: "applied" | "not-applied" | "unknown",
  ) {
    super("operational", `LINEAR_${stage}_${reason}`, [description(stage, reason)]);
    this.stage = stage;
    this.reason = reason;
    this.effect = effect;
    if (reason === "RATE_LIMITED") this.rateLimit = rateLimit;
  }
}

/** Preserve the original adapter stage, or classify bounded structured evidence without guessing. */
export function resourceOperationFailure(
  stage: ResourceFailureStage,
  error: unknown,
  effect?: "applied" | "not-applied" | "unknown",
): ResourceOperationFailure {
  if (error instanceof ResourceOperationFailure) {
    return error.effect !== undefined || effect === undefined
      ? error
      : new ResourceOperationFailure(error.stage, error.reason, error.rateLimit, effect);
  }
  const make = (reason: ResourceFailureReason) =>
    new ResourceOperationFailure(stage, reason, rateLimitInfoFromError(error), effect);
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof UnauthorizedError) return make("AUTH_REQUIRED");
    if (current instanceof StreamableHTTPError) {
      if (current.code === 401) return make("AUTH_REQUIRED");
      if (current.code === 403) return make("PERMISSION_DENIED");
      if (current.code === 429) return make("RATE_LIMITED");
    }
    if (current instanceof DOMException) {
      if (current.name === "TimeoutError") return make("TIMEOUT");
      if (current.name === "AbortError") return make("CANCELLED");
    }
    if (isConnectPhaseFailure(current)) return make("CONNECT_FAILED");
    const internal = internalReasons.get(current.message);
    if (internal) return make(internal);
    const code = (current as Error & { code?: unknown }).code;
    const transport = typeof code === "string" ? transportReasons.get(code) : undefined;
    if (transport) return make(transport);
    current = current.cause;
  }
  return make("UNKNOWN");
}
