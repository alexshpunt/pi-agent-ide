import { describe, expect, test, vi } from "vitest";
import { GithubApiError, GithubClient, type GithubCredentials } from "#github/client.ts";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

const token = "private-installation-token";
function credentials(): GithubCredentials {
  return {
    initialize: vi.fn(async () => undefined),
    getToken: vi.fn(async () => ({ token, expiresAt: Date.now() + 3600_000 })),
    identity: {
      login: "fixture[bot]",
      name: "fixture[bot]",
      email: "1+fixture[bot]@users.noreply.github.com",
    },
  };
}
function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}
function client(fetcher: typeof fetch, auth = credentials()): GithubClient {
  return new GithubClient(auth, {
    fetcher,
    coordinator: new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 }),
  });
}

test("only an exact missing-commit 422 is treated as not found", async () => {
  const route = "/repos/example/project/commits/missing%2Fref";
  const fetcher = vi.fn(async () =>
    json({ message: "No commit found for SHA: missing/ref" }, { status: 422 }),
  );
  await expect(client(fetcher).rest("GET", route)).rejects.toMatchObject({
    code: "GH_NOT_FOUND",
    status: 422,
    effect: "not-applied",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const [method, path, message] of [
    ["GET", route, "Validation Failed"],
    ["GET", route, "No commit found for SHA: another"],
    ["GET", "/repos/example/project/contents/missing", "No commit found for SHA: missing/ref"],
    ["POST", route, "No commit found for SHA: missing/ref"],
  ] as const) {
    await expect(
      client(async () => json({ message }, { status: 422 })).rest(method, path),
    ).rejects.toMatchObject({ code: "GH_HTTP_ERROR", status: 422 });
  }
});
test("equivalent simultaneous GETs share one acquisition and one cancelled reader cannot abort survivors", async () => {
  let began!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async () => {
    began();
    await pending;
    return json({ id: 42 });
  });
  const api = client(fetcher);
  const abort = new AbortController();
  const cancelled = api.rest("GET", "/repos/a/b", undefined, abort.signal);
  const rejection = expect(cancelled).rejects.toMatchObject({
    code: "GH_CANCELLED",
    effect: "not-applied",
  });
  const survivors = Array.from({ length: 9 }, () => api.rest("GET", "/repos/a/b"));
  await started;
  abort.abort();
  await rejection;
  finish();
  expect(await Promise.all(survivors)).toEqual(
    Array.from({ length: 9 }, () => ({ data: { id: 42 } })),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("a cancelled queued write is not applied and never reaches HTTP", async () => {
  let finish!: () => void;
  let began!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const send = vi.fn(async () => {
    began();
    await blocked;
    return json({ id: 1 });
  });
  const api = client(send);
  const first = api.rest("GET", "/repos/a/b");
  await started;
  const abort = new AbortController();
  const pending = api.rest("POST", "/repos/a/b/issues", { title: "queued" }, abort.signal);
  const failure = pending.catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 15));
  abort.abort();
  expect(await failure).toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
  finish();
  await first;
  expect(send).toHaveBeenCalledTimes(1);
});
// The client must never send App credentials outside GitHub, replay mutations or expose server secrets.
describe("native GitHub HTTP boundary", () => {
  test("cancelling the first initializer does not poison another request", async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((done) => {
      began = done;
    });
    const initialization = new Promise<void>((done) => {
      finish = done;
    });
    const auth = credentials();
    auth.initialize = vi.fn(async (signal?: AbortSignal) => {
      began();
      if (!signal) return initialization;
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void initialization.then(resolve, reject);
      });
    });
    const api = client(async () => json({ ok: true }), auth);
    const abort = new AbortController();
    const cancelled = api.rest("GET", "/repos/a/b", undefined, abort.signal);
    const survivor = api.rest("GET", "/repos/a/b");
    const outcome = survivor.catch((error: unknown) => error);
    await started;
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
    finish();
    await expect(outcome).resolves.toEqual({ data: { ok: true } });
  });
  test("sends App credentials to GitHub, refuses redirects and shares initialization", async () => {
    const auth = credentials();
    const fetcher = vi.fn(async () => json({ id: 1 }));
    const api = client(fetcher, auth);
    await Promise.all([
      api.rest("GET", "/repos/owner/repo"),
      api.rest("GET", "/repos/owner/repo/issues"),
    ]);
    expect(auth.initialize).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2026-03-10",
        }) as unknown,
      }),
    );
    expect(api.identity.login).toBe("fixture[bot]");
  });

  test.each([
    "https://api.github.com.evil.test/repos/owner/repo",
    "https://api.github.com@evil.test/",
    "https://user:secret@api.github.com/",
    "http://api.github.com/repos/owner/repo",
    "https://api.github.com:8443/",
    "//evil.test/",
    "repos/owner/repo",
    "/repos/owner/repo#fragment",
    "/\\evil.test/",
  ])("rejects an untrusted or malformed route before auth: %s", async (route) => {
    const auth = credentials();
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher, auth).rest("GET", route)).rejects.toMatchObject({
      code: "GH_INVALID_ROUTE",
      effect: "not-applied",
    });
    expect(auth.initialize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("returns only a trusted next-page link and never follows it automatically", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json([], {
        headers: {
          Link: '<https://api.github.com/repos/a/b/issues?page=2>; rel="next", <https://api.github.com/repos/a/b/issues?page=4>; rel="last"',
        },
      }),
    );
    await expect(client(fetcher).rest("GET", "/repos/a/b/issues")).resolves.toEqual({
      data: [],
      next: "https://api.github.com/repos/a/b/issues?page=2",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const hostile = client(async () =>
      json([], { headers: { Link: '<https://evil.test/token>; rel="next"' } }),
    );
    await expect(hostile.rest("GET", "/repos/a/b/issues")).rejects.toMatchObject({
      code: "GH_INVALID_PAGINATION",
      effect: "not-applied",
    });
  });

  test("treats invalid method/body combinations as local refusals", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).rest("TRACE", "/repos/a/b")).rejects.toMatchObject({
      code: "GH_INVALID_METHOD",
      effect: "not-applied",
    });
    await expect(client(fetcher).rest("GET", "/repos/a/b", { body: 1 })).rejects.toMatchObject({
      code: "GH_INVALID_INPUT",
      effect: "not-applied",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("reports permission and rate-limit refusals without reading or exposing their bodies", async () => {
    const api = client(async () =>
      json(
        { message: "server-secret " + token },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
      ),
    );
    const error = await api
      .rest("POST", "/repos/a/b/issues", { title: "test" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GithubApiError);
    expect(error).toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
      status: 403,
      retryAfter: "60",
    });
    expect(error instanceof Error ? error.toString() : error).not.toContain(token);
    expect(error instanceof Error ? error.toString() : error).not.toContain("server-secret");
    const forbidden = client(async () =>
      json({ message: token }, { status: 403, headers: { "retry-after": token } }),
    );
    await expect(forbidden.rest("GET", "/repos/a/b")).rejects.toMatchObject({
      code: "GH_FORBIDDEN",
      effect: "not-applied",
      retryAfter: undefined,
    });
  });

  test("reports failed and unreadable mutations as unknown without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(token);
    });
    const error = await client(fetcher)
      .rest("POST", "/repos/a/b/issues", { title: "test" })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GH_REQUEST_FAILED", effect: "unknown" });
    expect(error instanceof Error ? error.toString() : error).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      client(async () => new Response("not JSON")).rest("PATCH", "/repos/a/b/issues/1", {}),
    ).rejects.toMatchObject({ code: "GH_INVALID_RESPONSE", effect: "unknown" });
    await expect(
      client(async () => new Response("failure", { status: 502 })).rest(
        "POST",
        "/repos/a/b/issues",
        {},
      ),
    ).rejects.toMatchObject({ code: "GH_SERVER_ERROR", effect: "unknown" });
    await expect(client(fetcher).rest("GET", "/repos/a/b")).rejects.toMatchObject({
      code: "GH_REQUEST_FAILED",
      effect: "not-applied",
    });
  });

  test("caps bytes while streaming, cancels the body and classifies write uncertainty", async () => {
    let cancelled = false;
    const response = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    await expect(client(async () => response()).rest("GET", "/repos/a/b")).rejects.toMatchObject({
      code: "GH_RESPONSE_TOO_LARGE",
      effect: "not-applied",
    });
    expect(cancelled).toBe(true);
    await expect(
      client(async () => response()).rest("POST", "/repos/a/b/issues", {}),
    ).rejects.toMatchObject({ code: "GH_RESPONSE_TOO_LARGE", effect: "unknown" });
  });

  test("does not wait for a stalled stream cancellation after a declared oversized response", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          return new Promise<void>(() => undefined);
        },
      }),
      { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
    );
    await expect(client(async () => response).rest("GET", "/repos/a/b")).rejects.toMatchObject({
      code: "GH_RESPONSE_TOO_LARGE",
      effect: "not-applied",
    });
  });

  test("treats a mutation redirect response as uncertain, not as an explicit refusal", async () => {
    await expect(
      client(
        async () =>
          new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }),
      ).rest("POST", "/repos/a/b/issues", {}),
    ).rejects.toMatchObject({ code: "GH_HTTP_ERROR", effect: "unknown" });
  });
  test("pre-dispatch cancellation and auth failures are local refusals", async () => {
    const auth = credentials();
    auth.initialize = vi.fn(async () => {
      throw new Error(token);
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher, auth).rest("POST", "/repos/a/b/issues", {})).rejects.toMatchObject(
      { code: "GH_AUTH_FAILED", effect: "not-applied" },
    );
    expect(fetcher).not.toHaveBeenCalled();
    const signal = AbortSignal.abort(new Error(token));
    await expect(
      client(fetcher).rest("POST", "/repos/a/b/issues", {}, signal),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("caller cancellation after dispatch leaves a mutation uncertain", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url: unknown, options?: RequestInit) => {
      abort.abort(new Error(token));
      options?.signal?.throwIfAborted();
      return json({});
    });
    await expect(
      client(fetcher).rest("POST", "/repos/a/b/issues", {}, abort.signal),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("distinguishes GraphQL read errors from uncertain mutation and partial data", async () => {
    const api = client(async () =>
      json({ errors: [{ message: token }], data: { repository: null } }),
    );
    await expect(
      api.graphql('query($owner:String!){repository(owner:$owner,name:"b"){id}}', { owner: "a" }),
    ).rejects.toMatchObject({ code: "GH_GRAPHQL_ERROR", effect: "not-applied" });
    const error = await api
      .graphql('mutation { addComment(input:{subjectId:"x",body:"test"}){clientMutationId} }', {})
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GH_GRAPHQL_ERROR", effect: "unknown" });
    expect(error instanceof Error ? error.toString() : error).not.toContain(token);
    await expect(
      client(async () => {
        throw new Error(token);
      }).graphql("{ viewer { login } }", {}),
    ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "not-applied" });
  });

  test("returns typed GraphQL data and handles empty REST acknowledgements", async () => {
    await expect(
      client(async () => json({ data: { repository: { id: "r1" } } })).graphql<{
        repository: { id: string };
      }>('query{repository(owner:"a",name:"b"){id}}', {}),
    ).resolves.toEqual({ repository: { id: "r1" } });
    await expect(
      client(async () => new Response(null, { status: 204 })).rest(
        "DELETE",
        "/repos/a/b/issues/comments/1",
      ),
    ).resolves.toEqual({ data: undefined });
  });
});

describe("open App API requests", () => {
  test("returns status, media type and original JSON or text bytes without an operation list", async () => {
    const response = '{"custom_resource":{"id":7}}';
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(response, { status: 201, headers: { "content-type": "application/json" } }),
    );
    const result = await client(fetcher).request("POST", "/repos/a/b/a-new-api", {
      arbitrary: true,
    });
    expect(result).toEqual({
      status: 201,
      contentType: "application/json",
      bytes: new TextEncoder().encode(response),
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/a/b/a-new-api",
      expect.objectContaining({ body: '{"arbitrary":true}' }),
    );
    const textApi = client(
      async () => new Response("job log\nstep 2", { headers: { "content-type": "text/plain" } }),
    );
    expect(new TextDecoder().decode((await textApi.request("GET", "/custom/log")).bytes)).toBe(
      "job log\nstep 2",
    );
  });

  test("returns original binary bytes and trusted page links", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 128]);
    const result = await client(
      async () =>
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            link: '<https://api.github.com/custom?page=2>; rel="next"',
          },
        }),
    ).request("GET", "/custom");
    expect(result.bytes).toEqual(bytes);
    expect(result.next).toBe("https://api.github.com/custom?page=2");
  });

  test.each(["HEAD", "DELETE", "OPTIONS"])(
    "permits %s with an empty acknowledgement",
    async (method) => {
      const result = await client(async () => new Response(null, { status: 204 })).request(
        method,
        "/custom",
      );
      expect(result).toMatchObject({ status: 204, bytes: new Uint8Array() });
    },
  );

  test("refuses credentials and malformed Accept overrides before authentication", async () => {
    const auth = credentials();
    const fetcher = vi.fn<typeof fetch>();
    const api = client(fetcher, auth);
    await expect(
      api.request("GET", "/custom", undefined, undefined, {
        accept: "application/json\r\nAuthorization: secret",
      }),
    ).rejects.toMatchObject({ code: "GH_INVALID_INPUT", effect: "not-applied" });
    await expect(
      api.request("GET", "/custom", undefined, undefined, {
        headers: { Authorization: "secret" },
      } as never),
    ).rejects.toMatchObject({ code: "GH_INVALID_INPUT", effect: "not-applied" });
    expect(auth.initialize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("sends a validated Accept header but never accepts a foreign API host", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("diff", { headers: { "content-type": "text/plain" } }),
    );
    await client(fetcher).request("GET", "/repos/a/b/pulls/1", undefined, undefined, {
      accept: "application/vnd.github.diff",
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.diff",
          Authorization: "Bearer " + token,
        }) as unknown,
      }),
    );
    const auth = credentials();
    await expect(
      client(fetcher, auth).request("GET", "https://api.github.com.evil.test/foo"),
    ).rejects.toMatchObject({ code: "GH_INVALID_ROUTE", effect: "not-applied" });
    expect(auth.initialize).not.toHaveBeenCalled();
  });

  test("forwards GraphQL operationName and never labels an executed mutation read-only", async () => {
    const seen: string[] = [];
    const api = client(async (_url, options) => {
      if (typeof options?.body !== "string") throw new Error("Expected GraphQL JSON request body");
      seen.push(options.body);
      throw new Error(token);
    });
    await expect(
      api.request(
        "POST",
        "/graphql",
        {
          query:
            'query Read{viewer{login}} mutation Write{addComment(input:{subjectId:"x",body:"test"}){clientMutationId}}',
          variables: {},
        },
        undefined,
        { operationName: "Write" },
      ),
    ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "unknown" });
    expect(JSON.parse(seen[0] ?? "")).toMatchObject({ operationName: "Write", variables: {} });
    await expect(
      api.request("POST", "/graphql", {
        query: "query Read{viewer{login}}",
        operationName: "Read",
      }),
    ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "not-applied" });
    await expect(
      api.request(
        "GET",
        "/graphql?query=" +
          encodeURIComponent(
            'mutation Write{addComment(input:{subjectId:"x",body:"test"}){clientMutationId}}',
          ),
      ),
    ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "unknown" });
  });

  test("keeps REST post-dispatch cancellation uncertain and does not replay", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      abort.abort();
      throw new Error(token);
    });
    await expect(
      client(fetcher).request("PATCH", "/custom", { state: "changed" }, abort.signal),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("follows Actions download redirects without forwarding App credentials or exposing signed URLs", async () => {
    const signed =
      "https://productionresultssa0.blob.core.windows.net/actions/job.txt?sig=private-signature";
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      fetchUrl(url).startsWith("https://api.github.com/")
        ? new Response(null, { status: 302, headers: { location: signed } })
        : new Response("job output", { headers: { "content-type": "text/plain" } }),
    );
    const result = await client(fetcher).request("GET", "/repos/a/b/actions/jobs/123/logs");
    expect(new TextDecoder().decode(result.bytes)).toBe("job output");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const download = fetcher.mock.calls.at(1);
    if (!download) throw new Error("Expected redirect download request");
    expect(new Headers(download[1]?.headers).has("authorization")).toBe(false);
    expect(download[1]?.redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain("private-signature");
  });

  test.each([
    "/repos/a/b/actions/runs/12/logs",
    "/repos/a/b/actions/runs/12/attempts/2/logs",
    "/repos/a/b/actions/artifacts/12/zip",
    "/repos/a/b/zipball/main",
    "/repos/a/b/releases/assets/12",
  ])("allows credential-free GitHub download redirects for %s", async (route) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      fetchUrl(url).startsWith("https://api.github.com/")
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://objects.githubusercontent.com/download?signature=private",
            },
          })
        : new Response(Uint8Array.from([1, 2]), {
            headers: { "content-type": "application/octet-stream" },
          }),
    );
    const result = await client(fetcher).request("GET", route);
    expect(result.bytes).toEqual(Uint8Array.from([1, 2]));
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  });

  test.each([
    "https://evil.test/private",
    "https://127.0.0.1/private",
    "http://objects.githubusercontent.com/file",
    "https://user:secret@objects.githubusercontent.com/file",
    "https://objects.githubusercontent.com:8443/file",
    "https://objects.githubusercontent.com.evil.test/file",
  ])("refuses an untrusted download redirect: %s", async (target) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location: target } }),
    );
    await expect(
      client(fetcher).request("GET", "/repos/a/b/actions/jobs/1/logs"),
    ).rejects.toMatchObject({ code: "GH_UNTRUSTED_REDIRECT", effect: "not-applied" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("does not follow a mutation redirect or a non-download CDN redirect", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/file" },
        }),
    );
    await expect(client(fetcher).request("POST", "/custom", {})).rejects.toMatchObject({
      code: "GH_HTTP_ERROR",
      effect: "unknown",
    });
    await expect(client(fetcher).request("GET", "/custom")).rejects.toMatchObject({
      code: "GH_UNTRUSTED_REDIRECT",
      effect: "not-applied",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("caps redirect chains, text bytes and binary bytes without a stuck cancellation", async () => {
    let calls = 0;
    const loops = client(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://api.github.com/custom/${++calls}` },
        }),
    );
    await expect(loops.request("GET", "/custom")).rejects.toMatchObject({
      code: "GH_TOO_MANY_REDIRECTS",
      effect: "not-applied",
    });
    expect(calls).toBeLessThanOrEqual(6);
    for (const [type, size] of [
      ["text/plain", 2 * 1024 * 1024 + 1],
      ["application/octet-stream", 25 * 1024 * 1024 + 1],
    ] as const) {
      const oversized = client(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                return new Promise<void>(() => undefined);
              },
            }),
            { headers: { "content-type": type, "content-length": String(size) } },
          ),
      );
      await expect(oversized.request("GET", "/custom")).rejects.toMatchObject({
        code: "GH_RESPONSE_TOO_LARGE",
        effect: "not-applied",
      });
    }
  });

  test("keeps timeout and streamed binary overflow bounded and classifies mutation effects", async () => {
    const abort = new AbortController();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const api = client(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              began();
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    );
    const result = api.request("POST", "/custom", {}, abort.signal);
    await started;
    abort.abort(new DOMException("deadline", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ code: "GH_TIMEOUT", effect: "unknown" });
    let cancelled = false;
    const oversized = client(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(25 * 1024 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    );
    await expect(oversized.request("GET", "/custom")).rejects.toMatchObject({
      code: "GH_RESPONSE_TOO_LARGE",
      effect: "not-applied",
    });
    expect(cancelled).toBe(true);
  });

  test("keeps credentials on a trusted API redirect and cannot regain them after a CDN hop", async () => {
    const requests: RequestInit[] = [];
    const api = client(async (url, init) => {
      if (!init) throw new Error("Expected fetch options");
      requests.push(init);
      return fetchUrl(url).endsWith("/old")
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response("done", { headers: { "content-type": "text/plain" } });
    });
    expect(new TextDecoder().decode((await api.request("GET", "/old")).bytes)).toBe("done");
    expect(
      requests.every(
        (request) => new Headers(request.headers).get("authorization") === "Bearer " + token,
      ),
    ).toBe(true);
    const fetcher = vi.fn<typeof fetch>(
      async (url) =>
        new Response(null, {
          status: 302,
          headers: {
            location: fetchUrl(url).startsWith("https://api.github.com/")
              ? "https://objects.githubusercontent.com/file"
              : "https://api.github.com/repos/a/b",
          },
        }),
    );
    await expect(
      client(fetcher).request("GET", "/repos/a/b/actions/jobs/1/logs"),
    ).rejects.toMatchObject({ code: "GH_UNTRUSTED_REDIRECT", effect: "not-applied" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each(["access_token", "client_secret", "token"])(
    "rejects URL authorization override %s before authentication",
    async (name) => {
      const auth = credentials();
      await expect(
        client(vi.fn<typeof fetch>(), auth).request("GET", `/custom?${name}=secret`),
      ).rejects.toMatchObject({ code: "GH_INVALID_ROUTE", effect: "not-applied" });
      expect(auth.initialize).not.toHaveBeenCalled();
    },
  );
  test("never follows a redirect into a possible GraphQL mutation", async () => {
    const route = "/graphql?query=" + encodeURIComponent("mutation { operation { id } }");
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.github.com" + route },
        }),
    );
    await expect(client(fetcher).request("GET", "/custom")).rejects.toMatchObject({
      code: "GH_UNTRUSTED_REDIRECT",
      effect: "not-applied",
    });
    await expect(client(fetcher).request("GET", route)).rejects.toMatchObject({
      code: "GH_HTTP_ERROR",
      effect: "unknown",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test("rejects echoed provider credentials instead of returning them as raw bytes", async () => {
    await expect(
      client(async () => new Response(token)).request("GET", "/custom"),
    ).rejects.toMatchObject({ code: "GH_CREDENTIAL_IN_RESPONSE", effect: "not-applied" });
  });
});
