export const MAX_RETRY_AFTER_MS = 86_400_000;

/** Public quota diagnostics, compatible with the shared resource error metadata. */
export interface GithubRateLimitInfo {
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  readonly requestsLimit?: number;
  readonly requestsRemaining?: number;
  readonly endpoint?: string;
}

const numericFields = ["retryAfterMs", "resetAt", "requestsLimit", "requestsRemaining"] as const;
const endpoints = new Set([
  "core",
  "search",
  "code_search",
  "graphql",
  "integration_manifest",
  "dependency_snapshots",
  "code_scanning_upload",
  "actions_runner_registration",
]);

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Copy only public data properties; unknown fields and accessors never become diagnostics. */
export function safeRateLimitInfo(value: unknown): GithubRateLimitInfo | undefined {
  try {
    const info: Partial<Record<(typeof numericFields)[number], number>> & { endpoint?: string } =
      {};
    for (const field of numericFields) {
      const number = own(value, field);
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0 &&
        (field !== "retryAfterMs" || number <= MAX_RETRY_AFTER_MS)
      )
        info[field] = number;
    }
    const endpoint = own(value, "endpoint");
    if (typeof endpoint === "string" && endpoints.has(endpoint)) info.endpoint = endpoint;
    if (Object.keys(info).length) return Object.freeze(info);
  } catch {
    /* Unreadable optional metadata cannot replace the owning failure. */
  }
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value !== null && value.length <= 256 ? value.trim() : undefined;
}
function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,16}$/u.test(value)) return;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
function retryTiming(value: string | undefined): { delay: number } | { date: number } | undefined {
  const seconds = integer(value);
  if (seconds !== undefined && Number.isSafeInteger(seconds * 1000))
    return { delay: seconds * 1000 };
  if (
    !value ||
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      value,
    )
  )
    return;
  const date = Date.parse(value);
  if (Number.isSafeInteger(date) && date >= 0 && new Date(date).toUTCString() === value)
    return { date };
}

/** Convert GitHub epoch seconds and retain only the affected budget's retry deadline. */
export function rateLimitInfoFromHeaders(
  headers: Headers,
  now = Date.now(),
  limited = false,
): GithubRateLimitInfo {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 60_000)
    now = Date.now();
  const info: {
    requestsLimit?: number;
    requestsRemaining?: number;
    endpoint?: string;
    resetAt?: number;
    retryAfterMs?: number;
  } = {};
  const limit = integer(header(headers, "x-ratelimit-limit"));
  const remaining = integer(header(headers, "x-ratelimit-remaining"));
  if (limit !== undefined) info.requestsLimit = limit;
  if (remaining !== undefined) info.requestsRemaining = remaining;
  const endpoint = header(headers, "x-ratelimit-resource");
  if (endpoint !== undefined && endpoints.has(endpoint)) info.endpoint = endpoint;
  const deadlines: number[] = [];
  const retry = retryTiming(header(headers, "retry-after"));
  const deadline = retry && ("delay" in retry ? now + retry.delay : retry.date);
  if (deadline !== undefined && Number.isSafeInteger(deadline) && deadline > now)
    deadlines.push(deadline);
  // A secondary refusal must not borrow the reset time of an unexhausted primary budget.
  if (remaining === 0 || (limited && remaining === undefined)) {
    const resetSeconds = integer(header(headers, "x-ratelimit-reset"));
    const reset = resetSeconds === undefined ? undefined : resetSeconds * 1000;
    if (reset !== undefined && Number.isSafeInteger(reset) && reset > now) deadlines.push(reset);
  }
  if (!deadlines.length && (limited || remaining === 0)) deadlines.push(now + 60_000);
  if (deadlines.length) {
    info.resetAt = Math.max(...deadlines);
    // Preserve the full absolute deadline even when the public relative delay reaches its bound.
    info.retryAfterMs = Math.min(info.resetAt - now, MAX_RETRY_AFTER_MS);
  }
  return safeRateLimitInfo(info) ?? Object.freeze({});
}
const rateCodes = new Set(["RATE_LIMITED", "RATE_LIMIT"]);

/** Inspect bounded GitHub failure signals without forwarding response bodies or invoking accessors. */
export function isGithubRateLimitResponse(
  status: number,
  headers: Headers,
  data?: unknown,
): boolean {
  if (status === 429) return true;
  if (status !== 200 && status !== 403) return false;
  try {
    const exhausted = integer(header(headers, "x-ratelimit-remaining")) === 0;
    if (status === 403) {
      if (exhausted || retryTiming(header(headers, "retry-after")) !== undefined) return true;
      const message = own(data, "message");
      if (
        typeof message === "string" &&
        message.length <= 4096 &&
        /^(?:API rate limit exceeded\b|You have exceeded a secondary rate limit\b|You have triggered an abuse detection mechanism\b)/u.test(
          message,
        )
      )
        return true;
    }
    const errors = own(data, "errors");
    if (!Array.isArray(errors)) return false;
    const length = Object.getOwnPropertyDescriptor(errors, "length")?.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) return false;
    if (exhausted) return true;
    for (let index = 0; index < Math.min(length, 100); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
      const error: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      const type = own(error, "type");
      const code = own(own(error, "extensions"), "code");
      if (
        (typeof type === "string" && rateCodes.has(type)) ||
        (typeof code === "string" && rateCodes.has(code))
      )
        return true;
    }
  } catch {
    /* Foreign descriptors cannot replace the original response outcome. */
  }
  return false;
}
/** Local admission failure, before any request was dispatched. */
export class GithubRateLimitError extends Error {
  readonly code = "GH_RATE_LIMITED";
  readonly effect = "not-applied";
  readonly rateLimit: GithubRateLimitInfo;
  constructor(info: GithubRateLimitInfo) {
    super("GH_RATE_LIMITED");
    this.name = "GithubRateLimitError";
    this.rateLimit = safeRateLimitInfo(info) ?? Object.freeze({});
  }
}
