/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinearPreflightCache } from "#axi/preflight-cache.ts";
import {
  LinearRateLimitError,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
} from "#axi/rate-limit.ts";

void test("server retry and quota headers become bounded numeric metadata", () => {
  assert.deepEqual(
    rateLimitInfoFromHeaders(
      new Headers({
        "retry-after": "60",
        "x-ratelimit-requests-limit": "2500",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "160000",
      }),
      100000,
    ),
    { retryAfterMs: 60000, resetAt: 160000, requestsLimit: 2500, requestsRemaining: 0 },
  );
});

void test("HTTP dates take precedence while missing retry timing uses the latest exhausted reset", () => {
  const headers = new Headers({
    "retry-after": new Date(160000).toUTCString(),
    "x-ratelimit-complexity-remaining": "0",
    "x-ratelimit-complexity-reset": "180000",
    "x-ratelimit-endpoint-requests-remaining": "0",
    "x-ratelimit-endpoint-requests-reset": "170000",
    "x-ratelimit-endpoint-name": "issueSearch",
  });
  const value = rateLimitInfoFromHeaders(headers, 100000);
  assert.equal(value.retryAfterMs, 60000);
  assert.equal(value.resetAt, 160000);
  assert.equal(value.endpoint, "issueSearch");
  headers.delete("retry-after");
  const fallback = rateLimitInfoFromHeaders(headers, 100000);
  assert.equal(fallback.retryAfterMs, 80000);
  assert.equal(fallback.resetAt, 180000);
});

void test("confirmed limits honor Retry-After before the full bucket reset", () => {
  for (const retry of ["2", new Date(102000).toUTCString()]) {
    const info = rateLimitInfoFromHeaders(
      new Headers({
        "retry-after": retry,
        "x-ratelimit-requests-limit": "5000",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "3700000",
        "x-ratelimit-complexity-remaining": "0",
        "x-ratelimit-complexity-reset": "3700000",
      }),
      100000,
      true,
    );
    assert.equal(info.retryAfterMs, 2000);
    assert.equal(info.resetAt, 102000);
    assert.equal(info.requestsRemaining, 0);
  }
  for (const retry of ["invalid", "-1"]) {
    assert.equal(
      rateLimitInfoFromHeaders(
        new Headers({
          "retry-after": retry,
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": "3700000",
        }),
        100000,
        true,
      ).retryAfterMs,
      3600000,
    );
  }
});

void test("independent callers resume after Retry-After without waiting for a full refill", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-refill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 100000;
  let calls = 0;
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => now,
  };
  const request = () =>
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
      calls++;
      return calls === 1
        ? new Response("private", {
            status: 429,
            headers: {
              "retry-after": "2",
              "x-ratelimit-requests-remaining": "0",
              "x-ratelimit-requests-reset": "3700000",
            },
          })
        : new Response("{}");
    });
  await assert.rejects(request(), LinearRateLimitError);
  now = 101999;
  await assert.rejects(request(), LinearRateLimitError);
  assert.equal(calls, 1);
  now = 102000;
  assert.equal((await request()).status, 200);
  assert.equal(calls, 2);
});
void test("private or malformed rate metadata cannot cross the public boundary", () => {
  assert.deepEqual(
    safeRateLimitInfo({
      retryAfterMs: 1000,
      requestsRemaining: 0,
      authorization: "synthetic-private-value",
      endpoint: "private response with spaces",
      resetAt: NaN,
      requestsLimit: -1,
    }),
    { retryAfterMs: 1000, requestsRemaining: 0 },
  );
  assert.deepEqual(
    rateLimitInfoFromHeaders(
      new Headers({ "retry-after": "-5", "x-ratelimit-requests-limit": "private-value" }),
      100000,
    ),
    {},
  );
});

void test("429 cooldown is shared by independent callers without replaying requests", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 100000;
  let epoch = "a";
  let calls = 0;
  const options = {
    directory,
    scope: async () => ({
      connectionId: "11111111-1111-4111-8111-111111111111",
      epoch,
      server: "https://example.test/mcp",
    }),
    now: () => now,
  };
  const limited: typeof fetch = async () => {
    calls++;
    return new Response("synthetic-private-response", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  };
  const check = (error: unknown) => {
    assert(error instanceof LinearRateLimitError);
    assert.equal(error.message, "LINEAR_RATE_LIMITED");
    assert(typeof error.rateLimit.retryAfterMs === "number" && error.rateLimit.retryAfterMs > 0);
    assert(!JSON.stringify(error).includes("synthetic-private-response"));
    return true;
  };
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, limited),
    check,
  );
  await Promise.all(
    Array.from({ length: 3 }, () =>
      assert.rejects(
        new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, limited),
        check,
      ),
    ),
  );
  assert.equal(calls, 1);
  now += 60001;
  await new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(calls, 2);
  epoch = "b";
  await new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(calls, 3);
});

void test("a 2000ms rollback preserves cooldown receipts and the original expiry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-skew-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 100000;
  let calls = 0;
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => now,
  };
  await assert.rejects(
    new LinearPreflightCache(options).rateLimited(
      "https://example.test/mcp",
      new Headers({ "retry-after": "60" }),
    ),
    LinearRateLimitError,
  );
  const request = () =>
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
      calls++;
      return new Response("{}");
    });
  now -= 2000;
  await assert.rejects(request(), (error) => {
    assert(error instanceof LinearRateLimitError);
    assert.equal(error.rateLimit.resetAt, 160000);
    assert.equal(error.rateLimit.retryAfterMs, 60000);
    return true;
  });
  assert.equal(calls, 0);
  now = 160000;
  assert.equal((await request()).status, 200);
  assert.equal(calls, 1);
});

void test("a shorter in-flight rate signal cannot lose the longest cooldown after a rollback", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-skew-merge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 100000;
  let calls = 0;
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => now,
  };
  for (const retry of ["86400", "1"]) {
    await assert.rejects(
      new LinearPreflightCache(options).rateLimited(
        "https://example.test/mcp",
        new Headers({ "retry-after": retry }),
      ),
      LinearRateLimitError,
    );
    now = 98000;
  }
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
      calls++;
      return new Response("{}");
    }),
    (error) => {
      assert(error instanceof LinearRateLimitError);
      assert.equal(error.rateLimit.resetAt, 86500000);
      assert.equal(error.rateLimit.retryAfterMs, 86400000);
      return true;
    },
  );
  assert.equal(calls, 0);
});

void test("an exhausted successful response prevents additional traffic until its server reset", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-success-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const options = {
    directory,
    scope: async () => ({
      connectionId: "11111111-1111-4111-8111-111111111111",
      epoch: "a",
      server: "https://example.test/mcp",
    }),
    now: () => 100000,
  };
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response("{}", {
      headers: { "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "160000" },
    });
  };
  await new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, fetchImpl);
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, fetchImpl),
    LinearRateLimitError,
  );
  assert.equal(calls, 1);
});

void test("cooldowns do not leak from the MCP server to another API endpoint", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-servers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => 100000,
  };
  await assert.rejects(
    new LinearPreflightCache(options).fetch(
      "https://example.test/mcp",
      undefined,
      async () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
    ),
    LinearRateLimitError,
  );
  let calls = 0;
  await new LinearPreflightCache(options).fetch(
    "https://api.example.test/graphql",
    undefined,
    async () => {
      calls++;
      return new Response("{}");
    },
  );
  assert.equal(calls, 1);
});

void test("the cooldown store is bounded without evicting active limits or sending new traffic", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 100000;
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => now,
  };
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      writeFile(
        path.join(directory, index.toString(16).padStart(64, "0") + ".rate.json"),
        JSON.stringify({
          version: 1,
          createdAt: 100000,
          expiresAt: 200000,
          value: { retryAfterMs: 100000, resetAt: 200000 },
        }),
        { mode: 0o600 },
      ),
    ),
  );
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "60" } });
  };
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, fetchImpl),
    { message: "LINEAR_PREFLIGHT_CACHE_BUSY" },
  );
  assert.equal(calls, 0);
  now = 200001;
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, fetchImpl),
    LinearRateLimitError,
  );
  assert.equal(calls, 1);
  assert((await readdir(directory)).filter((name) => name.endsWith(".rate.json")).length <= 256);
});

void test("invalid old envelopes cannot extend a fresh server cooldown", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1000000000;
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => now,
  };
  const limited: typeof fetch = async () =>
    new Response("", { status: 429, headers: { "retry-after": "1" } });
  await assert.rejects(
    new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, limited),
    LinearRateLimitError,
  );
  const name = (await readdir(directory)).find((name) => name.endsWith(".rate.json"));
  assert(name);
  for (const [createdAt, expiresAt, retryAfterMs] of [
    [now + 1, now + 12 * 60 * 60_000, 12 * 60 * 60_000],
    [now - 48 * 60 * 60_000, now + 12 * 60 * 60_000, 12 * 60 * 60_000],
    [now + 1, now + 1, 0],
  ]) {
    await writeFile(
      path.join(directory, name),
      JSON.stringify({
        version: 1,
        createdAt,
        expiresAt,
        value: { resetAt: expiresAt, retryAfterMs },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, limited),
      LinearRateLimitError,
    );
    await assert.rejects(
      new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, limited),
      (error) => {
        assert(error instanceof LinearRateLimitError);
        assert.equal(error.rateLimit.retryAfterMs, 1000);
        return true;
      },
    );
  }
});

void test("503 Retry-After alone never manufactures a quota cooldown", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-unavailable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => 100000,
  };
  const response = await new LinearPreflightCache(options).fetch(
    "https://example.test/mcp",
    undefined,
    async () => new Response("", { status: 503, headers: { "retry-after": "60" } }),
  );
  assert.equal(response.status, 503);
  let calls = 0;
  await new LinearPreflightCache(options).fetch("https://example.test/mcp", undefined, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(calls, 1);
});

void test("body cancellation failure cannot replace confirmed rate-limit metadata", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new LinearPreflightCache({
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
  });
  await assert.rejects(
    cache.fetch(
      "https://example.test/mcp",
      undefined,
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw Error("synthetic-private-cleanup-error");
            },
          }),
          { status: 429, headers: { "retry-after": "60" } },
        ),
    ),
    (error) => {
      assert(error instanceof LinearRateLimitError);
      assert.equal(error.rateLimit.retryAfterMs, 60000);
      assert(!JSON.stringify(error).includes("synthetic-private-cleanup-error"));
      return true;
    },
  );
});

void test("a cooldown persistence failure still cancels the 429 body and retains its diagnosis", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-write-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cancelled = false;
  const cache = new LinearPreflightCache({
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
  });
  await assert.rejects(
    cache.fetch("https://example.test/mcp", undefined, async () => {
      await symlink(directory, path.join(directory, "rates.lock"));
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 429, headers: { "retry-after": "60" } },
      );
    }),
    (error) => {
      assert(error instanceof LinearRateLimitError);
      assert.equal(error.rateLimit.retryAfterMs, 60000);
      assert(error.cause instanceof Error);
      assert.equal(error.cause.message, "LINEAR_PREFLIGHT_CACHE_UNSAFE");
      return true;
    },
  );
  assert.equal(cancelled, true);
});

void test("query-distinguished server endpoints cannot share a cooldown", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-query-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let server = "https://same.example/mcp?tenant=a";
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server }),
    now: () => 100000,
  };
  await assert.rejects(
    new LinearPreflightCache(options).fetch(
      server,
      undefined,
      async () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
    ),
    LinearRateLimitError,
  );
  server = "https://same.example/mcp?tenant=b";
  let calls = 0;
  await new LinearPreflightCache(options).fetch(server, undefined, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(calls, 1);
});

void test("invalid cooldown envelopes do not permanently consume the bounded store", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-invalid-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => 100000,
  };
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      writeFile(
        path.join(directory, index.toString(16).padStart(64, "0") + ".rate.json"),
        JSON.stringify({
          version: 1,
          // Keep the envelope consistent, but beyond the 2000ms clock-skew allowance.
          createdAt: 102001,
          expiresAt: 200000,
          value: { retryAfterMs: 97999, resetAt: 200000 },
        }),
        { mode: 0o600 },
      ),
    ),
  );
  let calls = 0;
  const response = await new LinearPreflightCache(options).fetch(
    "https://example.test/mcp",
    undefined,
    async () => {
      calls++;
      return new Response("{}");
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".rate.json")).length, 0);
});

void test("a confirmed 429 honors a reset header even when counters are absent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-rate-reset-only-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new LinearPreflightCache({
    directory,
    scope: async () => ({ connectionId: "one", epoch: "a", server: "https://example.test/mcp" }),
    now: () => 100000,
  });
  await assert.rejects(
    cache.fetch(
      "https://example.test/mcp",
      undefined,
      async () =>
        new Response("", { status: 429, headers: { "x-ratelimit-requests-reset": "160000" } }),
    ),
    (error) => {
      assert(error instanceof LinearRateLimitError);
      assert.equal(error.rateLimit.retryAfterMs, 60000);
      assert.equal(error.rateLimit.resetAt, 160000);
      return true;
    },
  );
});
