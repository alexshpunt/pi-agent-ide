import { ResourceError } from "pi-agent-ide/api/resource";
const stages = ["CAPABILITIES", "WORKSPACE", "OPERATION", "ISSUE_ENRICHMENT"] as const;
const reasons = [
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "TIMEOUT",
  "CONNECTION_FAILED",
  "CONNECT_FAILED",
  "NATIVE_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "CONNECTION_REMOVED",
  "CONNECTION_CHANGED",
  "ISSUE_NOT_FOUND",
  "BACKEND_REJECTED",
  "VALIDATION_FAILED",
  "INVALID_RESPONSE",
  "IDENTITY_MISMATCH",
  "CANCELLED",
  "UNKNOWN",
] as const;

/** Closed AXI stages that can safely cross the resource-error boundary. */
export type LinearFailureStage = (typeof stages)[number];
/** Closed diagnoses; private backend text is never a diagnosis. */
export type LinearFailureReason = (typeof reasons)[number];
export const linearFailureReasons = {
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
} satisfies Record<LinearFailureReason, string>;

/** LINEAR_AXI_TIMEOUT: the local backend process, not Linear, exceeded its deadline. */
export const axiTimeout = "The local linear-axi process did not finish in time and was stopped.";

/** Validate a staged AXI error before using its stage for effects or recovery advice. */
export function parseLinearResourceFailure(code: string):
  | {
      readonly stage: LinearFailureStage;
      readonly reason: LinearFailureReason;
    }
  | undefined {
  for (const stage of stages) {
    const prefix = `LINEAR_${stage}_`;
    if (!code.startsWith(prefix)) continue;
    const reason = reasons.find((value) => value === code.slice(prefix.length));
    if (reason) return { stage, reason };
  }
}

const numericRateFields = [
  "retryAfterMs",
  "resetAt",
  "requestsLimit",
  "requestsRemaining",
  "complexityLimit",
  "complexityRemaining",
  "endpointLimit",
  "endpointRemaining",
] as const;
export type LinearRateLimitInfo = Readonly<
  Partial<Record<(typeof numericRateFields)[number], number>> & { endpoint?: string }
>;

/** Accept only bounded public counters and timing, never headers or response bodies. */
export function safeLinearRateLimitInfo(value: unknown): LinearRateLimitInfo | undefined {
  if (typeof value === "string") {
    if (value.length > 4096) return;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const output: Partial<Record<(typeof numericRateFields)[number], number>> & {
    endpoint?: string;
  } = {};
  for (const field of numericRateFields) {
    const number = input[field];
    if (
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number >= 0 &&
      (field !== "retryAfterMs" || number <= 86_400_000)
    )
      output[field] = number;
  }
  if (typeof input.endpoint === "string" && /^[A-Za-z0-9_:-]{1,80}$/u.test(input.endpoint))
    output.endpoint = input.endpoint;
  return Object.keys(output).length ? Object.freeze(output) : undefined;
}

/** Exceptions cross process and provider boundaries only through this public metadata. */
export function linearErrorRateLimit(error: unknown): LinearRateLimitInfo | undefined {
  if (!error || typeof error !== "object") return;
  try {
    const direct: unknown = Object.getOwnPropertyDescriptor(error, "rateLimit")?.value;
    const metadata: unknown = Object.getOwnPropertyDescriptor(error, "metadata")?.value;
    return (
      safeLinearRateLimitInfo(direct) ??
      safeLinearRateLimitInfo(
        metadata && typeof metadata === "object"
          ? Object.getOwnPropertyDescriptor(metadata, "rateLimit")?.value
          : undefined,
      )
    );
  } catch {
    return;
  }
}
export function withLinearRateLimit<T extends Error>(
  error: T,
  value: unknown,
): T & { readonly rateLimit?: LinearRateLimitInfo } {
  const rateLimit = safeLinearRateLimitInfo(value);
  return rateLimit ? Object.assign(error, { rateLimit }) : error;
}
export function linearResourceError(
  code: string,
  source: string,
  effect: "applied" | "not-applied" | "unknown",
  rateLimit?: unknown,
): ResourceError & { readonly rateLimit?: LinearRateLimitInfo } {
  const safe = safeLinearRateLimitInfo(rateLimit);
  return withLinearRateLimit(
    new ResourceError(code, source, effect, safe ? { metadata: { rateLimit: safe } } : undefined),
    safe,
  );
}
