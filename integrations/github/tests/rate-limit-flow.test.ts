import { expect, test, vi } from "vitest";
import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubClient, type GithubCredentials } from "#github/client.ts";
import { GithubBackend } from "#github/backend.ts";
import { createGithubResolver } from "#github/resource.ts";
import { GithubApiResources } from "#github/api.ts";
import { GithubAssets } from "#github/assets.ts";
import { parseGithubAddress } from "#github/address.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GithubNotSentError, GithubRequestCoordinator } from "#github/request-coordinator.ts";

function credentials(login = "quota-fixture"): GithubCredentials {
  return {
    identity: { login, name: login, email: "quota@example.invalid" },
    quotaOwner: `user:${login}`,
    async initialize() {},
    async getToken() {
      return { token: "synthetic-credential-not-for-output", expiresAt: Date.now() + 3600_000 };
    },
  };
}
function setup(
  response: () => Response,
  owner = "quota-fixture",
  coordinator = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 }),
) {
  const send = vi.fn<typeof fetch>(async () => response());
  const client = new GithubClient(credentials(owner), { fetcher: send, coordinator });
  return { send, client, coordinator };
}
test("asset downloads share the API cooldown and preserve safe diagnostics", async () => {
  const { send, client } = setup(() => limited());
  // Only metadata succeeds; the binary acquisition is the rate-limited send.
  send.mockImplementationOnce(async () =>
    Response.json({
      id: 9,
      name: "fixture.bin",
      size: 1,
      content_type: "application/octet-stream",
    }),
  );
  const assets = new GithubAssets(
    async () => credentials(),
    async () => client,
    { fetcher: send },
  );
  for (let i = 0; i < 2; i++) {
    const result = await assets
      .resolver()
      .tryResolve("github://owner/repo/releases/assets/9", { cwd: "/fixture" });
    if (result.kind !== "resolved") throw new Error("Expected asset resource");
    if (!result.resource.read) throw new Error("Expected a readable resource");
    await expect(
      result.resource.read({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
      metadata: { rateLimit: { retryAfterMs: expect.any(Number) as unknown } },
    });
  }
  expect(send).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "asset upload respects shared admission and preserves unknown verification: %s",
  async (created) => {
    const directory = await mkdtemp(path.join(tmpdir(), "github-asset-rate-"));
    try {
      await writeFile(path.join(directory, "fixture.bin"), new Uint8Array([1]));
      const { send, client } = setup(limited);
      send.mockImplementationOnce(async () =>
        Response.json({
          id: 7,
          draft: true,
          upload_url: "https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}",
        }),
      );
      if (created)
        send.mockImplementationOnce(async () =>
          Response.json(
            { id: 9, name: "fixture.bin", size: 1, content_type: "application/octet-stream" },
            {
              status: 201,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
                "x-ratelimit-resource": "core",
              },
            },
          ),
        );
      const assets = new GithubAssets(
        async () => credentials(),
        async () => client,
        { fetcher: send },
      );
      const address = parseGithubAddress("github://owner/repo/releases/7/assets/new");
      if (!address) throw new Error("Expected an upload address");
      const first = await assets
        .upload(address, JSON.stringify({ file: "fixture.bin", name: "fixture.bin" }), directory)
        .catch((error: unknown) => error);
      expect(first).toMatchObject({
        code: created ? "GH_ASSET_UPLOAD_UNVERIFIED" : "GH_RATE_LIMITED",
        effect: created ? "unknown" : "not-applied",
        metadata: { rateLimit: { requestsRemaining: 0 } },
      });
      await expect(
        assets.upload(
          address,
          JSON.stringify({ file: "fixture.bin", name: "fixture.bin" }),
          directory,
        ),
      ).rejects.toMatchObject({ code: "GH_RATE_LIMITED", effect: "not-applied" });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
const limited = () =>
  Response.json(
    { message: "upstream-private-payload" },
    {
      status: 429,
      headers: {
        "retry-after": "60",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-resource": "core",
        "x-private-debug": "secret-header",
      },
    },
  );

test("post-dispatch observation failure cannot claim an unknown GraphQL mutation was not applied", async () => {
  const { send, client, coordinator } = setup(() =>
    Response.json({ errors: [{ type: "RATE_LIMITED" }] }),
  );
  vi.spyOn(coordinator, "observe").mockRejectedValueOnce(
    new GithubNotSentError("GH_RATE_STATE_UNSAFE"),
  );
  await expect(
    client.graphql("mutation { updateIssue(input:{}) { issue { id } } }", {}),
  ).rejects.toMatchObject({
    code: "GH_RATE_STATE_UNSAFE",
    effect: "unknown",
    metadata: { rateLimit: { retryAfterMs: 60_000 } },
  });
  expect(send).toHaveBeenCalledTimes(1);
});
test("a successful final PATCH followed by quota exhaustion stays unknown without replay", async () => {
  const issue = {
    number: 12,
    title: "Fixture",
    body: "Original",
    updated_at: "revision-0",
    html_url: "https://github.com/owner/repo/issues/12",
  };
  const { send, client } = setup(() => Response.json(issue));
  send.mockImplementation(async (_url, init) =>
    Response.json(
      issue,
      init?.method === "PATCH"
        ? {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
              "x-ratelimit-resource": "core",
            },
          }
        : undefined,
    ),
  );
  const result = await createGithubResolver(new GithubBackend(async () => client)).tryResolve(
    "github://owner/repo/issues/12#body",
    { cwd: "/fixture" },
  );
  if (result.kind !== "resolved") throw new Error("Expected editable resource");
  if (!result.resource.write) throw new Error("Expected a writable resource");
  await expect(
    result.resource.write([{ type: "text", text: "Replacement" }], {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: "GH_SAVE_UNVERIFIED",
    effect: "unknown",
    metadata: { rateLimit: { requestsRemaining: 0 } },
  });
  expect(send.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "PATCH"]);
});
test("rate metadata survives the actual backend and public resource resolver boundary", async () => {
  const { send, client } = setup(limited);
  const resolver = createGithubResolver(new GithubBackend(async () => client));
  const source = "github://owner/repo/issues/12";
  for (let i = 0; i < 2; i++) {
    const result = await resolver.tryResolve(source, { cwd: "/fixture" });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected failed resource");
    expect(result.error).toBeInstanceOf(ResourceError);
    const error = result.error as ResourceError;
    expect(error).toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
      metadata: { rateLimit: { requestsLimit: 5000, requestsRemaining: 0, endpoint: "core" } },
    });
    expect(error.metadata?.rateLimit?.resetAt).toBeGreaterThan(Date.now());
    expect(error.metadata?.rateLimit?.retryAfterMs).toBeGreaterThan(50_000);
    expect(JSON.stringify(error)).not.toMatch(
      /upstream-private-payload|secret-header|synthetic-credential/,
    );
  }
  expect(send).toHaveBeenCalledTimes(1);
});

test("universal API actions preserve safe cooldown diagnostics without a second HTTP call", async () => {
  const { send, client } = setup(limited);
  const api = new GithubApiResources(async () => client);
  for (let i = 0; i < 2; i++) {
    const error = await api
      .perform(
        "github://api/rest",
        JSON.stringify({ method: "GET", path: "/repos/owner/repo" }),
        "/fixture",
      )
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
      metadata: { rateLimit: { requestsRemaining: 0 } },
    });
  }
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  ["query { viewer { login } }", "not-applied"],
  ["mutation { updateIssue(input: {}) { issue { id } } }", "unknown"],
] as const)(
  "GraphQL HTTP-200 limits preserve %s effect and stop later GraphQL sends",
  async (query, effect) => {
    const { send, client } = setup(() =>
      Response.json(
        {
          data: { viewer: null },
          errors: [{ type: "RATE_LIMITED", message: "upstream-private-payload" }],
        },
        {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
            "x-ratelimit-resource": "graphql",
          },
        },
      ),
    );
    await expect(client.graphql(query, {})).rejects.toMatchObject({
      code: "GH_RATE_LIMITED",
      effect,
      metadata: { rateLimit: { requestsRemaining: 0, endpoint: "graphql" } },
    });
    await expect(client.graphql(query, {})).rejects.toMatchObject({
      code: "GH_RATE_LIMITED",
      effect: "not-applied",
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test("secondary 403 is not confused with permission denial and its cooldown does not cross users", async () => {
  const { client, send, coordinator } = setup(() =>
    Response.json(
      { message: "You have exceeded a secondary rate limit." },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600),
        },
      },
    ),
  );
  await expect(client.rest("GET", "/user")).rejects.toMatchObject({
    code: "GH_RATE_LIMITED",
    metadata: { rateLimit: { retryAfterMs: 60_000 } },
  });
  await expect(client.rest("GET", "/user")).rejects.toMatchObject({ code: "GH_RATE_LIMITED" });
  expect(send).toHaveBeenCalledTimes(1);
  const other = setup(
    () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    "different-user",
    coordinator,
  );
  await expect(other.client.rest("GET", "/user")).rejects.toMatchObject({ code: "GH_FORBIDDEN" });
  await expect(other.client.rest("GET", "/user")).rejects.toMatchObject({ code: "GH_FORBIDDEN" });
  expect(other.send).toHaveBeenCalledTimes(2);
});
