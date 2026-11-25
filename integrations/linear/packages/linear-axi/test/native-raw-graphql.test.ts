import assert from "node:assert/strict";
import test from "node:test";
import { NativeRawGraphqlClient, validateRawGraphqlRequest } from "#axi/native-raw-graphql.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import { fixtureRecord } from "./fixtures/json.ts";
import { buildSchema, graphql } from "graphql";
import { LinearRateLimitError } from "#axi/rate-limit.ts";

const secret = "fixture-native-secret";
const org = { id: "10000000-0000-4000-8000-000000000001", urlKey: "example" };
const request = {
  query: "mutation Fixture($value: String!) { arbitraryMutation(value: $value) { id } }",
  variables: { value: "Fixture value" },
  operationName: "Fixture",
};
function fixture(
  reply: unknown = { data: { arbitraryMutation: { id: "fixture-id" } } },
  options: {
    status?: number;
    headers?: Record<string, string>;
    fail?: boolean;
    scope?: string;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit; body: FixtureGraphqlRequest }> = [];
  let authorizations = 0;
  const client = new NativeRawGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => {
        authorizations++;
        return "Bearer " + secret;
      },
    },
    fetchImpl: async (url, init) => {
      const body = fixtureGraphqlRequest(init);
      assert(init);
      calls.push({ url: url instanceof Request ? url.url : String(url), init, body });
      if (calls.length === 1)
        return Response.json({
          data: { viewer: { organization: { ...org, urlKey: options.scope ?? org.urlKey } } },
        });
      if (options.fail) throw new Error("private transport details " + secret);
      return Response.json(reply, { status: options.status ?? 200, headers: options.headers });
    },
  });
  return { client, calls, authorized: () => authorizations };
}

void test("an arbitrary named mutation reaches only the verified native endpoint once", async () => {
  const f = fixture();
  const r = await f.client.execute(request, "example");
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "success");
  assert.equal(r.effect, "applied");
  assert.equal(r.operationType, "mutation");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { arbitraryMutation: { id: "fixture-id" } });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body, request);
  assert(
    f.calls.every((c) => c.url === "https://api.linear.app/graphql" && c.init.redirect === "error"),
  );
  assert.equal(f.authorized(), 1);
});

void test("operation selection respects fragments, comments and strings instead of keyword guesses", () => {
  const query =
    '# mutation Wrong\nquery Read { viewer { ...User name(arg: "mutation {") } } fragment User on User { id } mutation Change { arbitraryMutation { id } }';
  assert.equal(validateRawGraphqlRequest({ query, operationName: "Read" }).operationType, "query");
  assert.equal(
    validateRawGraphqlRequest({ query, operationName: "Change" }).operationType,
    "mutation",
  );
  assert.equal(validateRawGraphqlRequest({ query: "{ viewer { id } }" }).operationType, "query");
});

void test("invalid documents, ambiguous selection and transport overrides fail before authorization", async () => {
  const f = fixture();
  for (const input of [
    { query: "mutation Broken {" },
    { query: "query A { viewer { id } } query B { viewer { id } }" },
    { query: "query A { viewer { id } } query A { viewer { id } }", operationName: "A" },
    { query: "{ viewer { id } } query B { viewer { id } }", operationName: "B" },
    { query: "query A { viewer { id } }", operationName: "Missing" },
    { query: "fragment User on User { id }" },
    { query: "type User { id: ID }" },
    { query: "subscription Watch { issues { id } }" },
    { ...request, endpoint: "https://untrusted.invalid/graphql" },
    { ...request, headers: { authorization: secret } },
    { ...request, token: secret },
    { ...request, variables: [] },
    { ...request, operationName: "A B" },
    { query: "{ " + "x ".repeat(10001) + "}" },
  ])
    await assert.rejects(f.client.execute(input, "example"), {
      message: "LINEAR_GRAPHQL_INPUT_INVALID",
    });
  assert.equal(f.authorized(), 0);
  assert.equal(f.calls.length, 0);
});

void test("a foreign workspace refuses the raw request without a mutation", async () => {
  const f = fixture(undefined, { scope: "other" });
  const r = await f.client.execute(request, "example");
  assert.equal(r.ok, false);
  assert.equal(r.effect, "not-applied");
  assert.equal(r.error, "LINEAR_IDENTITY_MISMATCH");
  assert.equal(f.calls.length, 1);
});

void test("GraphQL partial data and extensions survive while mutation effects remain unknown", async () => {
  const errors = [
    { message: "Fixture field failed", path: ["second"], extensions: { code: "FORBIDDEN" } },
  ];
  for (const status of [200, 403, 429]) {
    const f = fixture(
      {
        data: { first: { id: "created-id" }, second: null },
        errors,
        extensions: { fixture: 3 },
      },
      { status },
    );
    const r = await f.client.execute(request, "example");
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "partial");
    assert.equal(r.effect, "unknown");
    assert.deepEqual(r.data, { first: { id: "created-id" }, second: null });
    assert.deepEqual(r.errors, errors);
    assert.deepEqual(r.extensions, { fixture: 3 });
    assert.equal(f.calls.length, 2);
  }
});

void test("permission and rate refusals keep safe diagnostics and are not retried", async () => {
  for (const status of [401, 403, 429]) {
    const f = fixture(
      { errors: [{ message: "Fixture refusal" }] },
      {
        status,
        headers: {
          "retry-after": "2",
          "x-ratelimit-requests-remaining": "0",
          "x-private-token": secret,
          "x-ratelimit-endpoint-name": secret,
        },
      },
    );
    const r = await f.client.execute(request, "example");
    assert.equal(r.status, status);
    assert.equal(r.effect, "not-applied");
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 2);
    assert(!JSON.stringify(r).includes(secret));
    if (status === 429) {
      assert(r.rateLimit);
      assert.equal(r.rateLimit.retryAfterMs, 2000);
      assert.equal(r.rateLimit.requestsRemaining, 0);
    }
  }
});

void test("unknown dispatch, invalid responses and server failures never claim mutation success or replay", async () => {
  for (const f of [
    fixture(undefined, { fail: true }),
    fixture({ unexpected: true }),
    fixture({ data: "invalid scalar root" }),
    fixture({ errors: [{ message: "Fixture failure" }] }, { status: 500 }),
  ]) {
    const r = await f.client.execute(request, "example");
    assert.equal(r.effect, "unknown");
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 2);
    assert(!JSON.stringify(r).includes(secret));
  }
});

void test("the actual authorization secret cannot survive in returned JSON keys, data or errors", async () => {
  const f = fixture({
    data: { [secret]: "Bearer " + secret },
    errors: [{ message: "private " + secret }],
    extensions: { secret },
  });
  const r = await f.client.execute(request, "example");
  assert(!JSON.stringify(r).includes(secret));
  assert.equal(r.effect, "unknown");
  assert.equal(r.outcome, "partial");
});

void test("queries with GraphQL errors have no mutation effect", async () => {
  const f = fixture({ data: { viewer: null }, errors: [{ message: "Fixture error" }] });
  const r = await f.client.execute({ query: "query Read { viewer { id } }" }, "example");
  assert.equal(r.operationType, "query");
  assert.equal(r.effect, "not-applied");
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 2);
});

void test("caller cancellation and a whole-call deadline stop further dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  const before = await f.client.execute(request, "example", controller.signal);
  assert.equal(before.effect, "not-applied");
  assert.equal(f.calls.length, 0);
  let calls = 0;
  const client = new NativeRawGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => "Bearer " + secret,
    },
    timeoutMs: 20,
    fetchImpl: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return Response.json({ data: {} });
    },
  });
  const r = await client.execute(request, "example");
  assert.equal(r.effect, "not-applied");
  assert.equal(r.error, "LINEAR_GRAPHQL_TIMEOUT");
  assert.equal(calls, 1);
});

void test("cancellation after raw dispatch and oversized bodies remain unknown without replay", async () => {
  for (const scenario of ["cancel", "oversized"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const client = new NativeRawGraphqlClient({
      tokenProvider: {
        getToken: async () => assert.fail("Expected a native authorization header"),
        getAuthorization: async () => "Bearer " + secret,
      },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return Response.json({ data: { viewer: { organization: org } } });
        if (scenario === "cancel") {
          controller.abort();
          return new Promise(() => {});
        }
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      },
    });
    const r = await client.execute(request, "example", controller.signal);
    assert.equal(r.effect, "unknown");
    assert.equal(r.ok, false);
    assert.equal(calls, 2);
    assert.equal(
      r.error,
      scenario === "cancel" ? "LINEAR_GRAPHQL_CANCELLED" : "LINEAR_GRAPHQL_RESPONSE_TOO_LARGE",
    );
  }
});

void test("connection changes between scope verification and dispatch prevent a mutation", async () => {
  let calls = 0;
  const client = new NativeRawGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => "Bearer " + secret,
      assertCurrentAuthorization: async () => {
        if (calls === 1) throw Error("LINEAR_AUTH_CONTEXT_CHANGED");
      },
    },
    fetchImpl: async () => {
      calls++;
      return Response.json({ data: { viewer: { organization: org } } });
    },
  });
  const r = await client.execute(request, "example");
  assert.equal(r.error, "LINEAR_AUTH_CONTEXT_CHANGED");
  assert.equal(r.effect, "not-applied");
  assert.equal(calls, 1);
});
void test("null propagation after a committed mutation never proves an HTTP refusal had no effect", async () => {
  const schema = buildSchema(
    "type Query { unused: String } type Mutation { first: String! second: String! }",
  );
  for (const status of [401, 403, 429]) {
    let committed = 0;
    let calls = 0;
    const client = new NativeRawGraphqlClient({
      tokenProvider: {
        getToken: async () => assert.fail("Expected a native authorization header"),
        getAuthorization: async () => "Bearer " + secret,
      },
      fetchImpl: async (_url, init) => {
        calls++;
        if (calls === 1) return Response.json({ data: { viewer: { organization: org } } });
        const input = fixtureGraphqlRequest(init);
        const result = await graphql({
          schema,
          source: input.query,
          rootValue: {
            first: () => {
              committed++;
              return "saved";
            },
            second: () => {
              throw new Error("Fixture field refusal");
            },
          },
        });
        assert.equal(result.data, null);
        assert.deepEqual(result.errors?.[0]?.path, ["second"]);
        return Response.json(result, { status });
      },
    });
    const result = await client.execute({ query: "mutation { first second }" }, "example");
    assert.equal(committed, 1);
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.effect, "unknown");
    assert.equal(result.data, null);
    assert.deepEqual(fixtureRecord(result.errors?.[0]).path, ["second"]);
  }
});

void test("execution paths and malformed refusal bodies cannot establish pre-execution rejection", async () => {
  for (const reply of [
    { errors: [{ message: "Fixture execution failure", path: ["first"] }] },
    { unexpected: true },
  ]) {
    for (const status of [401, 403, 429]) {
      const f = fixture(reply, { status });
      const result = await f.client.execute(request, "example");
      assert.equal(result.effect, "unknown");
      assert.equal(result.ok, false);
      assert.equal(f.calls.length, 2);
    }
  }
});

void test("a rate-limit exception after dispatch does not erase uncertain mutation effects", async () => {
  let calls = 0;
  const client = new NativeRawGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => "Bearer " + secret,
    },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return Response.json({ data: { viewer: { organization: org } } });
      throw new LinearRateLimitError({ retryAfterMs: 17 });
    },
  });
  const result = await client.execute(request, "example");
  assert.equal(result.error, "LINEAR_RATE_LIMITED");
  assert.equal(result.effect, "unknown");
  assert.equal(result.rateLimit?.retryAfterMs, 17);
  assert.equal(calls, 2);
});

void test("synchronous cancellation races observe rejected auth, fetch and body promises", async () => {
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", observe);
  try {
    for (const phase of ["authorization", "fetch", "body"] as const) {
      const controller = new AbortController();
      let calls = 0;
      const client = new NativeRawGraphqlClient({
        tokenProvider: {
          getToken: async () => assert.fail("Expected a native authorization header"),
          getAuthorization: () => {
            if (phase === "authorization") {
              controller.abort();
              return Promise.reject(new Error("Fixture authorization cancellation"));
            }
            return Promise.resolve("Bearer " + secret);
          },
        },
        fetchImpl: async () => {
          calls++;
          if (calls === 1) return Response.json({ data: { viewer: { organization: org } } });
          if (phase === "fetch") {
            controller.abort();
            return Promise.reject(new Error("Fixture fetch cancellation"));
          }
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(stream) {
                  controller.abort();
                  stream.error(new Error("Fixture body cancellation"));
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
      });
      const result = await client.execute(request, "example", controller.signal);
      assert.equal(result.error, "LINEAR_GRAPHQL_CANCELLED");
      assert.equal(result.effect, phase === "authorization" ? "not-applied" : "unknown");
      assert.equal(calls, phase === "authorization" ? 0 : 2);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
});

void test("an authorization change during an awaited quota observer discards old response data", async () => {
  for (const status of [200, 429]) {
    let changed = false;
    let calls = 0;
    let observations = 0;
    const client = new NativeRawGraphqlClient({
      tokenProvider: {
        getToken: async () => assert.fail("Expected a native authorization header"),
        getAuthorization: async () => "Bearer " + secret,
        assertCurrentAuthorization: async () => {
          if (changed) throw Error("LINEAR_AUTH_CONTEXT_CHANGED");
        },
      },
      onRateLimit: async () => {
        observations++;
        await Promise.resolve();
        changed = true;
        throw new LinearRateLimitError({ retryAfterMs: 1000 });
      },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return Response.json({ data: { viewer: { organization: org } } });
        return Response.json(
          {
            data: { privateFixture: "Previous connection data" },
            errors: [{ message: "Fixture quota failure", extensions: { code: "RATE_LIMITED" } }],
            extensions: { privateFixture: "Previous connection extensions" },
          },
          { status, headers: { "retry-after": "1" } },
        );
      },
    });
    const result = await client.execute(request, "example");
    assert.equal(result.error, "LINEAR_AUTH_CONTEXT_CHANGED");
    assert.equal(result.effect, "unknown");
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.equal(Object.hasOwn(result, "errors"), false);
    assert.equal(Object.hasOwn(result, "extensions"), false);
    assert.equal(calls, 2);
    assert.equal(observations, 1);
  }
});

void test("a changed managed authorization context is retained rather than replaced or retried", async () => {
  const client = new NativeRawGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => {
        throw Error("LINEAR_AUTH_CONTEXT_CHANGED");
      },
    },
    fetchImpl: async () => {
      throw Error("must not dispatch");
    },
  });
  const r = await client.execute(request, "example");
  assert.equal(r.effect, "not-applied");
  assert.equal(r.error, "LINEAR_AUTH_CONTEXT_CHANGED");
});
