export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
export type RateLimitObserver = (headers: Headers) => Promise<never>;

/** The caller has decoded an explicit GraphQL rate code, not private message text. */
export async function rejectRateLimit(
  headers: Headers,
  observer?: RateLimitObserver,
): Promise<never> {
  if (observer) return observer(headers);
  throw new LinearRateLimitError(rateLimitInfoFromHeaders(headers, Date.now(), true));
}
export interface RateLimitInfo {
  retryAfterMs?: number;
  resetAt?: number;
  requestsLimit?: number;
  requestsRemaining?: number;
  complexityLimit?: number;
  complexityRemaining?: number;
  endpointLimit?: number;
  endpointRemaining?: number;
  endpoint?: string;
}
const numericFields = [
  "retryAfterMs",
  "resetAt",
  "requestsLimit",
  "requestsRemaining",
  "complexityLimit",
  "complexityRemaining",
  "endpointLimit",
  "endpointRemaining",
] as const;
export function safeRateLimitInfo(value: unknown): RateLimitInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: RateLimitInfo = {};
  for (const field of numericFields) {
    const number = input[field];
    if (
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number >= 0 &&
      (field !== "retryAfterMs" || number <= MAX_COOLDOWN_MS)
    )
      result[field] = number;
  }
  if (typeof input.endpoint === "string" && /^[A-Za-z0-9_:-]{1,80}$/u.test(input.endpoint))
    result.endpoint = input.endpoint;
  return Object.keys(result).length ? result : undefined;
}
/** Only public quota counters and timing survive; headers, bodies and tokens never do. */
export class LinearRateLimitError extends Error {
  readonly rateLimit: RateLimitInfo;
  constructor(info: RateLimitInfo, options?: ErrorOptions) {
    super("LINEAR_RATE_LIMITED", options);
    this.rateLimit = Object.freeze(safeRateLimitInfo(info) ?? {});
  }
}
export function rateLimitInfoFromHeaders(
  headers: Headers,
  now = Date.now(),
  limited = false,
): RateLimitInfo {
  const result: RateLimitInfo = {};
  const deadlines: number[] = [];
  const retry = headers.get("retry-after")?.trim();
  if (retry && /^\d+(?:\.\d+)?$/u.test(retry)) {
    const delay = Number(retry) * 1000;
    if (Number.isFinite(delay)) deadlines.push(now + Math.min(Math.ceil(delay), MAX_COOLDOWN_MS));
  } else if (retry && /^[A-Za-z]{3},.* GMT$/u.test(retry)) {
    const date = Date.parse(retry);
    if (Number.isFinite(date) && date > now) deadlines.push(Math.min(date, now + MAX_COOLDOWN_MS));
  }
  const retryDeadline = deadlines.at(0);
  const integer = (name: string): number | undefined => {
    const text = headers.get(name);
    if (text === null || !/^\d+$/u.test(text)) return undefined;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  for (const [prefix, limit, remaining] of [
    ["requests", "requestsLimit", "requestsRemaining"],
    ["complexity", "complexityLimit", "complexityRemaining"],
    ["endpoint-requests", "endpointLimit", "endpointRemaining"],
  ] as const) {
    const maximum = integer("x-ratelimit-" + prefix + "-limit");
    const left = integer("x-ratelimit-" + prefix + "-remaining");
    if (maximum !== undefined) result[limit] = maximum;
    if (left !== undefined) result[remaining] = left;
    if (left === 0 || (limited && left === undefined)) {
      const reset = integer("x-ratelimit-" + prefix + "-reset");
      if (reset !== undefined && reset > now)
        deadlines.push(Math.min(reset, now + MAX_COOLDOWN_MS));
    }
  }
  const endpoint = headers.get("x-ratelimit-endpoint-name");
  if (endpoint && /^[A-Za-z0-9_:-]{1,80}$/u.test(endpoint)) result.endpoint = endpoint;
  if (deadlines.length) {
    // Linear refills continuously. Retry-After permits another request before the
    // bucket reaches its full-reset timestamp, including body-level rejections.
    result.resetAt = retryDeadline ?? Math.max(...deadlines);
    result.retryAfterMs = Math.max(0, result.resetAt - now);
  }
  return result;
}
export function rateLimitInfoFromError(error: unknown): RateLimitInfo | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const value = current as { rateLimit?: unknown; cause?: unknown };
    const info = safeRateLimitInfo(value.rateLimit);
    if (info) return info;
    current = value.cause;
  }
  return undefined;
}
