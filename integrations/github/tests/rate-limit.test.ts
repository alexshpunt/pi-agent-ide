import { describe, expect, it, vi } from "vitest";
import {
  GithubRateLimitError,
  MAX_RETRY_AFTER_MS,
  isGithubRateLimitResponse,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
} from "#github/rate-limit.ts";

describe("safe public GitHub rate-limit metadata", () => {
  it("copies only bounded quota and timing fields into an immutable snapshot", () => {
    const input = {
      retryAfterMs: 0,
      resetAt: 1_900_000_000_000,
      requestsLimit: 5000,
      requestsRemaining: 0,
      endpoint: "core",
      token: "private-canary",
    };
    const info = safeRateLimitInfo(input);
    expect(info).toEqual({
      retryAfterMs: 0,
      resetAt: input.resetAt,
      requestsLimit: 5000,
      requestsRemaining: 0,
      endpoint: "core",
    });
    expect(Object.isFrozen(info)).toBe(true);
    input.requestsRemaining = 10;
    expect(info?.requestsRemaining).toBe(0);
    expect(JSON.stringify(info)).not.toContain(input.token);
  });

  it("omits invalid numbers, inherited fields and unsafe endpoint values", () => {
    for (const value of [
      null,
      [],
      "core",
      { retryAfterMs: MAX_RETRY_AFTER_MS + 1 },
      { resetAt: Infinity },
      { requestsLimit: 1.5 },
      { requestsRemaining: -1 },
      { requestsRemaining: Number.MAX_SAFE_INTEGER + 1 },
      { endpoint: "core\nprivate" },
      { endpoint: "https://private.invalid/token" },
      { endpoint: "ghp_private_canary" },
      Object.create({ resetAt: 1_900_000_000_000 }),
    ]) {
      expect(safeRateLimitInfo(value)).toBeUndefined();
    }
    expect(safeRateLimitInfo({ retryAfterMs: MAX_RETRY_AFTER_MS, requestsLimit: 0 })).toEqual({
      retryAfterMs: MAX_RETRY_AFTER_MS,
      requestsLimit: 0,
    });
  });

  it("does not invoke metadata accessors or propagate unreadable descriptors", () => {
    const get = vi.fn(() => {
      throw new Error("private-canary");
    });
    const input = Object.defineProperties({}, { retryAfterMs: { get }, endpoint: { get } });
    expect(safeRateLimitInfo(input)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    const unreadable = new Proxy({}, { getOwnPropertyDescriptor: get });
    expect(safeRateLimitInfo(unreadable)).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retains the machine failure contract with a separate immutable metadata copy", () => {
    const input = {
      retryAfterMs: 60_000,
      resetAt: 1_900_000_000_000,
      endpoint: "graphql",
      privateField: "private-canary",
    };
    const error = new GithubRateLimitError(input);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("GH_RATE_LIMITED");
    expect(error.effect).toBe("not-applied");
    expect(error.rateLimit).toEqual({
      retryAfterMs: 60_000,
      resetAt: input.resetAt,
      endpoint: "graphql",
    });
    expect(Object.isFrozen(error.rateLimit)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(input.privateField);
    input.retryAfterMs = 1;
    expect(error.rateLimit.retryAfterMs).toBe(60_000);
    expect(new GithubRateLimitError({})).toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
      rateLimit: {},
    });
    expect(Object.isFrozen(new GithubRateLimitError({}).rateLimit)).toBe(true);
  });
});

const now = Date.parse("2026-10-25T10:00:00Z");

describe("GitHub response quota headers", () => {
  it("converts reset seconds to milliseconds and respects both primary deadlines", () => {
    const resetAt = now + 120_000;
    const info = rateLimitInfoFromHeaders(
      new Headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt / 1000),
        "retry-after": "60",
        "x-ratelimit-resource": "core",
      }),
      now,
      true,
    );
    expect(info).toEqual({
      requestsLimit: 5000,
      requestsRemaining: 0,
      resetAt,
      retryAfterMs: 120_000,
      endpoint: "core",
    });
    expect(Object.isFrozen(info)).toBe(true);
  });

  it("does not delay a secondary limit until a still-available primary budget resets", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4000",
      "x-ratelimit-reset": String((now + 3_600_000) / 1000),
      "retry-after": "5",
      "x-ratelimit-resource": "graphql",
    });
    expect(rateLimitInfoFromHeaders(headers, now, true)).toEqual({
      requestsLimit: 5000,
      requestsRemaining: 4000,
      resetAt: now + 5000,
      retryAfterMs: 5000,
      endpoint: "graphql",
    });
    headers.delete("retry-after");
    expect(rateLimitInfoFromHeaders(headers, now, true)).toEqual({
      requestsLimit: 5000,
      requestsRemaining: 4000,
      resetAt: now + 60_000,
      retryAfterMs: 60_000,
      endpoint: "graphql",
    });
  });

  it("records a successful exhausted budget without inventing a failure", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String((now + 30_000) / 1000),
    });
    expect(rateLimitInfoFromHeaders(headers, now)).toEqual({
      requestsRemaining: 0,
      resetAt: now + 30_000,
      retryAfterMs: 30_000,
    });
    headers.set("x-ratelimit-remaining", "2");
    expect(rateLimitInfoFromHeaders(headers, now)).toEqual({ requestsRemaining: 2 });
  });

  it("accepts canonical future HTTP dates", () => {
    const resetAt = now + 45_000;
    expect(
      rateLimitInfoFromHeaders(
        new Headers({ "retry-after": new Date(resetAt).toUTCString() }),
        now,
        true,
      ),
    ).toEqual({ resetAt, retryAfterMs: 45_000 });
  });

  it.each([
    "not-a-date",
    "60.5",
    "-1",
    "1e3",
    "Wed, 01 Jan 2020 00:00:00 GMT",
    "Thu, 31 Feb 2028 12:00:00 GMT",
    "0",
  ])("uses a one-minute fallback for unusable retry timing %s", (retry) => {
    expect(rateLimitInfoFromHeaders(new Headers({ "retry-after": retry }), now, true)).toEqual({
      resetAt: now + 60_000,
      retryAfterMs: 60_000,
    });
  });

  it("preserves a long server deadline while bounding the public relative delay", () => {
    const delay = MAX_RETRY_AFTER_MS + 60_000;
    expect(
      rateLimitInfoFromHeaders(new Headers({ "retry-after": String(delay / 1000) }), now, true),
    ).toEqual({ resetAt: now + delay, retryAfterMs: MAX_RETRY_AFTER_MS });
  });

  it("does not use oversized numbers or unknown headers as public metadata", () => {
    const info = rateLimitInfoFromHeaders(
      new Headers({
        "retry-after": "9007199254740991",
        "x-ratelimit-reset": "9007199254740991",
        "x-ratelimit-limit": "1.5",
        "x-ratelimit-remaining": "-1",
        "x-ratelimit-resource": "ghp_private_canary",
        authorization: "private-canary",
      }),
      now,
      true,
    );
    expect(info).toEqual({ resetAt: now + 60_000, retryAfterMs: 60_000 });
    expect(JSON.stringify(info)).not.toContain("private");
  });

  it("uses a safe fallback only when a limit is confirmed", () => {
    expect(rateLimitInfoFromHeaders(new Headers(), now, true)).toEqual({
      resetAt: now + 60_000,
      retryAfterMs: 60_000,
    });
    const none = rateLimitInfoFromHeaders(new Headers(), now);
    expect(none).toEqual({});
    expect(Object.isFrozen(none)).toBe(true);
  });
});

describe("GitHub rate-limit response detection", () => {
  it.each([
    [429, {}, undefined],
    [403, { "x-ratelimit-remaining": "0" }, undefined],
    [403, { "retry-after": "0" }, undefined],
    [403, { "retry-after": "60" }, { message: "private-canary" }],
    [
      403,
      {},
      {
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      },
    ],
    [403, {}, { message: "API rate limit exceeded for synthetic-user." }],
    [
      403,
      {},
      {
        message:
          "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.",
      },
    ],
    [200, {}, { errors: [{ type: "RATE_LIMITED", message: "private-canary" }] }],
    [200, {}, { errors: [{ type: "RATE_LIMIT" }] }],
    [200, {}, { errors: [{ extensions: { code: "RATE_LIMITED" } }] }],
    [403, {}, { errors: [{ type: "RATE_LIMITED" }] }],
    [200, { "x-ratelimit-remaining": "0" }, { errors: [{ type: "OTHER" }] }],
  ] as const)("recognizes an explicit limit at HTTP %s", (status, values, data) => {
    expect(isGithubRateLimitResponse(status, new Headers(values), data)).toBe(true);
  });

  it.each([
    [200, { "x-ratelimit-remaining": "0" }, { data: { viewer: { login: "synthetic-user" } } }],
    [200, { "x-ratelimit-remaining": "0" }, { errors: [] }],
    [200, {}, { errors: [{ type: "FORBIDDEN", message: "private-canary" }] }],
    [
      403,
      { "x-ratelimit-remaining": "4000" },
      { message: "Resource not accessible by integration" },
    ],
    [403, { "retry-after": "private-canary" }, { message: "Forbidden" }],
    [403, {}, { message: "The rate limit setting cannot be changed by this user" }],
    [401, { "x-ratelimit-remaining": "0" }, undefined],
    [503, { "retry-after": "60" }, undefined],
    [403, {}, { message: "x".repeat(5000) + "You have exceeded a secondary rate limit." }],
  ] as const)("keeps non-limit responses distinct at HTTP %s", (status, values, data) => {
    expect(isGithubRateLimitResponse(status, new Headers(values), data)).toBe(false);
  });

  it("never invokes body accessors, inherited error fields or hostile descriptors", () => {
    const get = vi.fn(() => {
      throw new Error("private-canary");
    });
    for (const field of ["message", "errors"]) {
      const body = Object.defineProperty({}, field, { get });
      expect(isGithubRateLimitResponse(403, new Headers(), body)).toBe(false);
      expect(isGithubRateLimitResponse(200, new Headers(), body)).toBe(false);
    }
    const error = Object.defineProperty({}, "type", { get });
    expect(isGithubRateLimitResponse(200, new Headers(), { errors: [error] })).toBe(false);
    const extension = Object.defineProperty({}, "code", { get });
    expect(
      isGithubRateLimitResponse(200, new Headers(), { errors: [{ extensions: extension }] }),
    ).toBe(false);
    expect(
      isGithubRateLimitResponse(200, new Headers(), {
        errors: [Object.create({ type: "RATE_LIMITED" })],
      }),
    ).toBe(false);
    expect(get).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: get });
    expect(isGithubRateLimitResponse(200, new Headers(), proxy)).toBe(false);
    expect(isGithubRateLimitResponse(429, new Headers(), proxy)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
