import { GithubRateLimitError } from "#github/rate-limit.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { expect, test, vi } from "vitest";
import { GithubClient } from "#github/client.ts";
import { verifyUser, refreshUserToken } from "#github/connections/oauth.ts";

test("cold personal identity discovery transfers exhausted quota to the verified upstream owner", async () => {
  const coordinator = isolatedCoordinator();
  const fetcher = vi.fn(async () =>
    Response.json(
      { id: 42, login: "fixture", type: "User" },
      {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
          "x-ratelimit-resource": "core",
        },
      },
    ),
  );
  let verified = false;
  const client = new GithubClient(
    {
      get quotaOwner() {
        return verified ? "user:fixture" : undefined;
      },
      identity: { login: "fixture", name: "Fixture", email: "fixture@example.invalid" },
      async initialize() {
        await verifyUser("fixture-token", { coordinator, fetcher });
        verified = true;
      },
      async getToken() {
        return { token: "fixture-token", expiresAt: Date.now() + 3600_000 };
      },
    },
    { coordinator, fetcher },
  );
  await expect(client.rest("GET", "/repos/o/r/issues/1")).rejects.toMatchObject({
    code: "GH_RATE_LIMITED",
    effect: "not-applied",
    metadata: { rateLimit: { requestsRemaining: 0 } },
  });
  await expect(
    verifyUser("another-fixture-token", { coordinator, fetcher, quotaOwner: "user:fixture" }),
  ).rejects.toMatchObject({ code: "GH_RATE_LIMITED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
function limited() {
  return new Response("{}", {
    status: 429,
    headers: { "retry-after": "60", "content-type": "application/json" },
  });
}

test("authorization stops HTTP during a confirmed cooldown and retains the safe deadline", async () => {
  const fetcher = vi.fn(async () => limited());
  const options = { coordinator: isolatedCoordinator(), fetcher };
  const first = await verifyUser("fixture-private-token", options).catch((error: unknown) => error);
  const second = await verifyUser("fixture-private-token", options).catch(
    (error: unknown) => error,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const error of [first, second]) {
    expect(error).toMatchObject({ code: "GH_RATE_LIMITED", effect: "not-applied" });
    if (!(error instanceof GithubRateLimitError)) throw new Error("Expected a rate limit");
    expect(error.rateLimit.retryAfterMs).toBeGreaterThan(50_000);
    expect(error.rateLimit.resetAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(error)).not.toContain("fixture-private-token");
  }
});

test("refresh limit refuses another send but a different OAuth application remains independent", async () => {
  const fetcher = vi.fn(async () => limited());
  const secret = {
    kind: "device",
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
  } as const;
  const options = { coordinator: isolatedCoordinator(), fetcher };
  await refreshUserToken("Iv1_fixture_app", secret, options).catch(() => {});
  const blocked = await refreshUserToken("Iv1_fixture_app", secret, options).catch(
    (error: unknown) => error,
  );
  expect(blocked).toMatchObject({ code: "GH_RATE_LIMITED", effect: "not-applied" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await refreshUserToken("Iv1_another_app", secret, options).catch(() => {});
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("cancelled authorization queued behind the same user sends no HTTP", async () => {
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async () => {
    started();
    await wait;
    return Response.json({ id: 42, login: "fixture", type: "User" });
  });
  const options = { coordinator: isolatedCoordinator(), quotaOwner: "user:fixture", fetcher };
  const first = verifyUser("fixture-first", options);
  await ready;
  const controller = new AbortController();
  const queued = verifyUser("fixture-second", { ...options, signal: controller.signal });
  const failure = expect(queued).rejects.toMatchObject({ message: "GH_AUTH_CANCELLED" });
  controller.abort();
  await failure;
  release();
  expect((await first).login).toBe("fixture");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("secondary authorization refusal is not mistaken for permission denial", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4000",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600),
        },
      }),
  );
  const options = { coordinator: isolatedCoordinator(), fetcher };
  const first = await verifyUser("fixture-secondary", options).catch((error: unknown) => error);
  const second = await verifyUser("fixture-secondary", options).catch((error: unknown) => error);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const error of [first, second]) {
    expect(error).toMatchObject({
      code: "GH_RATE_LIMITED",
      rateLimit: { requestsRemaining: 4000 },
    });
    if (!(error instanceof GithubRateLimitError)) throw new Error("Expected a rate limit");
    expect(error.rateLimit.retryAfterMs).toBeGreaterThan(50_000);
    if (!(error instanceof GithubRateLimitError)) throw new Error("Expected a rate limit");
    expect(error.rateLimit.retryAfterMs).toBeLessThanOrEqual(60_000);
  }
});
