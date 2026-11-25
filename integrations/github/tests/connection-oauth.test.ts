import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { describe, expect, it, vi } from "vitest";
import { deviceLogin, refreshUserToken, verifyUser } from "#github/connections/oauth.ts";
import type { GithubSecret } from "#github/connections/types.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

const start = Date.parse("2026-10-23T12:00:00Z");
const clientId = "Iv1_user_owned_app";
const accessToken = "ghu_access_canary";
const refreshToken = "ghr_refresh_canary";
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function device(extra: Record<string, unknown> = {}) {
  return {
    device_code: "d".repeat(40),
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
    ...extra,
  };
}
function granted(extra: Record<string, unknown> = {}) {
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 28_800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15_897_600,
    ...extra,
  };
}
function queued(...responses: Array<Response | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit; fields: URLSearchParams }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = responses.shift();
    if (!value) throw new Error("Unexpected request");
    if (!init) throw new Error("Expected fetch options");
    if (!(init.body instanceof URLSearchParams) && init.body != null)
      throw new Error("Expected form body");
    calls.push({ url: fetchUrl(url), init, fields: new URLSearchParams(init.body ?? undefined) });
    return typeof value === "function" ? value() : value;
  }) as typeof fetch;
  return { coordinator: isolatedCoordinator(), fetcher, calls };
}
function clock() {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    waits,
    wait: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}
const saved: Extract<GithubSecret, { kind: "device" }> = {
  kind: "device",
  accessToken,
  expiresAt: start - 1,
  refreshToken,
  refreshExpiresAt: start + 100_000,
};

describe("local GitHub device authorization", () => {
  it("uses the user's Client ID, waits while pending, and returns only the secret result", async () => {
    const http = queued(json(device()), json({ error: "authorization_pending" }), json(granted()));
    const time = clock();
    const onCode = vi.fn();
    const secret = await deviceLogin(clientId, onCode, { ...http, ...time });
    expect(onCode).toHaveBeenCalledWith({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-EFGH",
      expiresAt: start + 900_000,
    });
    expect(JSON.stringify(onCode.mock.calls)).not.toContain("d".repeat(40));
    expect(time.waits).toEqual([5000, 5000]);
    expect(secret).toEqual({
      kind: "device",
      accessToken,
      expiresAt: start + 10_000 + 28_800_000,
      refreshToken,
      refreshExpiresAt: start + 10_000 + 15_897_600_000,
    });
    expect(http.calls.at(0)?.url).toBe("https://github.com/login/device/code");
    expect(http.calls.at(0)?.fields.get("client_id")).toBe(clientId);
    for (const call of http.calls) {
      expect(call.init.redirect).toBe("error");
      expect(new Headers(call.init.headers).get("accept")).toBe("application/json");
      expect(new Headers(call.init.headers).get("content-type")).toContain(
        "application/x-www-form-urlencoded",
      );
      expect(call.fields.has("client_secret")).toBe(false);
      expect(call.init.headers).not.toHaveProperty("Authorization");
    }
    expect(http.calls.at(1)?.fields.get("device_code")).toBe("d".repeat(40));
    expect(http.calls.at(1)?.fields.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  it("keeps the slower interval for every later poll", async () => {
    const http = queued(
      json(device()),
      json({ error: "slow_down", interval: 12 }),
      json({ error: "authorization_pending" }),
      json(granted()),
    );
    const time = clock();
    await deviceLogin(clientId, () => {}, { ...http, ...time });
    expect(time.waits).toEqual([5000, 12_000, 12_000]);
  });

  it("accepts non-expiring user access tokens without inventing a refresh token", async () => {
    const http = queued(
      json(device()),
      json({ access_token: accessToken, token_type: "bearer", scope: "" }),
    );
    expect(await deviceLogin(clientId, () => {}, { ...http, ...clock() })).toEqual({
      kind: "device",
      accessToken,
    });
  });

  it.each([
    "access_denied",
    "expired_token",
    "token_expired",
    "device_flow_disabled",
    "incorrect_client_credentials",
    "canary-secret-error",
  ])("stops on %s without echoing server descriptions", async (error) => {
    const http = queued(json(device()), json({ error, error_description: accessToken }));
    let caught: unknown;
    try {
      await deviceLogin(clientId, () => {}, { ...http, ...clock() });
    } catch (value) {
      caught = value;
    }
    if (!(caught instanceof Error)) throw new Error("Expected authorization failure");
    expect(caught.message).toMatch(/^GH_AUTH_[A-Z_]+$/);
    expect(caught.message).not.toContain(accessToken);
    expect(caught.message).not.toContain(error);
    expect(http.calls).toHaveLength(2);
  });

  it("does not poll after the code has expired", async () => {
    const http = queued(json(device({ expires_in: 3 })));
    const time = clock();
    await expect(deviceLogin(clientId, () => {}, { ...http, ...time })).rejects.toThrow(
      "GH_AUTH_DEVICE_EXPIRED",
    );
    expect(http.calls).toHaveLength(1);
  });

  it("cancels before polling and while a fetch ignores the abort signal", async () => {
    const controller = new AbortController();
    const http = queued(json(device()));
    await expect(
      deviceLogin(clientId, () => controller.abort(), { ...http, signal: controller.signal }),
    ).rejects.toThrow("GH_AUTH_CANCELLED");
    expect(http.calls).toHaveLength(1);

    const stalled = new AbortController();
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    const pending = deviceLogin(clientId, () => {}, {
      coordinator: isolatedCoordinator(),
      fetcher,
      signal: stalled.signal,
    });
    stalled.abort();
    await expect(pending).rejects.toThrow("GH_AUTH_CANCELLED");
  });

  it.each([
    { verification_uri: "https://evil.example/login/device" },
    { verification_uri: "https://github.com.evil.example/login/device" },
    { user_code: "ABCD\nSECR" },
    { interval: 0 },
    { expires_in: -1 },
    { device_code: "bad\r\ncode" },
  ])("refuses an unsafe device response %j", async (bad) => {
    const http = queued(json(device(bad)));
    const onCode = vi.fn();
    await expect(deviceLogin(clientId, onCode, { ...http, ...clock() })).rejects.toThrow(
      "GH_AUTH_RESPONSE_INVALID",
    );
    expect(onCode).not.toHaveBeenCalled();
  });

  it("rejects a malformed token response without returning its contents", async () => {
    const http = queued(json(device()), json(granted({ access_token: "bad\r\n" + accessToken })));
    await expect(deviceLogin(clientId, () => {}, { ...http, ...clock() })).rejects.toThrow(
      "GH_AUTH_RESPONSE_INVALID",
    );
  });

  it("handles an abort inside fetch without leaving a secret-bearing rejected promise unhandled", async () => {
    const controller = new AbortController();
    const fetcher = (async () => {
      controller.abort();
      throw new Error(accessToken);
    }) as typeof fetch;
    await expect(
      deviceLogin(clientId, () => {}, {
        coordinator: isolatedCoordinator(),
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toThrow("GH_AUTH_CANCELLED");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("bounds response bytes and never waits for stalled reader cancellation", async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(65_537));
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const http = queued(oversized);
    await expect(deviceLogin(clientId, () => {}, { ...http })).rejects.toThrow(
      "GH_AUTH_RESPONSE_INVALID",
    );
  }, 1000);

  it("cancels stalled response-body reads", async () => {
    const controller = new AbortController();
    const http = queued(
      new Response(new ReadableStream<Uint8Array>({}), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = deviceLogin(clientId, () => {}, { ...http, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("GH_AUTH_CANCELLED");
  });

  it("does not follow redirects or expose network exception contents", async () => {
    const http = queued(json({ error_description: accessToken }, 302));
    await expect(deviceLogin(clientId, () => {}, { ...http })).rejects.toThrow(
      "GH_AUTH_REDIRECT_BLOCKED",
    );
    const fetcher = vi.fn(async () => {
      throw new Error(accessToken);
    }) as typeof fetch;
    await expect(
      deviceLogin(clientId, () => {}, { coordinator: isolatedCoordinator(), fetcher }),
    ).rejects.toThrow("GH_AUTH_REQUEST_FAILED");
  });

  it("rejects header or form injection input before contacting GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      deviceLogin("bad\nclient", () => {}, { coordinator: isolatedCoordinator(), fetcher }),
    ).rejects.toThrow("GH_AUTH_INVALID_INPUT");
    await expect(
      verifyUser("bad\r\ntoken", { coordinator: isolatedCoordinator(), fetcher }),
    ).rejects.toThrow("GH_AUTH_INVALID_INPUT");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("local GitHub user token refresh and identity", () => {
  it("rotates tokens using the user's Client ID without client_secret", async () => {
    const http = queued(json(granted({ access_token: "ghu_next", refresh_token: "ghr_next" })));
    expect(await refreshUserToken(clientId, saved, { ...http, now: () => start })).toEqual({
      kind: "device",
      accessToken: "ghu_next",
      expiresAt: start + 28_800_000,
      refreshToken: "ghr_next",
      refreshExpiresAt: start + 15_897_600_000,
    });
    expect(Object.fromEntries(http.calls.at(0)?.fields ?? [])).toEqual({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect(http.calls.at(0)?.init.redirect).toBe("error");
  });

  it("refuses missing or expired refresh tokens without a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      refreshUserToken(
        clientId,
        { ...saved, refreshToken: undefined },
        { coordinator: isolatedCoordinator(), fetcher, now: () => start },
      ),
    ).rejects.toThrow("GH_AUTH_REFRESH_REQUIRED");
    await expect(
      refreshUserToken(
        clientId,
        { ...saved, refreshExpiresAt: start },
        { coordinator: isolatedCoordinator(), fetcher, now: () => start },
      ),
    ).rejects.toThrow("GH_AUTH_REFRESH_EXPIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, refreshToken])(
    "rejects missing or non-rotated refresh credentials %s",
    async (nextRefresh) => {
      const http = queued(json(granted({ refresh_token: nextRefresh })));
      await expect(
        refreshUserToken(clientId, saved, { ...http, now: () => start }),
      ).rejects.toThrow("GH_AUTH_RESPONSE_INVALID");
    },
  );

  it("verifies the actual user and handles a private email", async () => {
    const http = queued(json({ id: 123, login: "octocat", type: "User", name: null, email: null }));
    expect(await verifyUser(accessToken, http)).toEqual({
      login: "octocat",
      name: "octocat",
      email: "123+octocat@users.noreply.github.com",
    });
    const call = http.calls.at(0);
    if (!call) throw new Error("Expected a fetch request");
    expect(call.url).toBe("https://api.github.com/user");
    expect(call.init.method).toBe("GET");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer " + accessToken);
    expect(call.init.redirect).toBe("error");
  });

  it.each([
    { id: 0, login: "octocat" },
    { id: 1, login: "other\naccount" },
    { id: 1, login: "octocat", type: "Organization" },
    { id: 1, login: "octocat", name: accessToken },
    { id: 1, login: "octocat", email: "\u001b[31mfoo@example.com" },
  ])("rejects an unverifiable or credential-echoing identity %j", async (identity) => {
    const http = queued(json(identity));
    const result = await verifyUser(accessToken, http).catch((value: Error) => value);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("GH_AUTH_UNVERIFIED");
  });

  it.each([
    [401, "GH_AUTH_UNAUTHORIZED"],
    [403, "GH_AUTH_FORBIDDEN"],
    [429, "GH_RATE_LIMITED"],
    [503, "GH_AUTH_SERVER_FAILED"],
  ])(
    "classifies authorization HTTP %s without exposing response contents",
    async (status, code) => {
      const http = queued(json({ message: accessToken }, status));
      const failure = await verifyUser(accessToken, http).catch((error: Error) => error);
      if (!(failure instanceof Error)) throw new Error("Expected identity failure");
      expect(failure.message).toBe(code);
      expect(failure.toString()).not.toContain(accessToken);
    },
  );
  it("returns safe errors for denied identity and refresh responses", async () => {
    const denied = queued(json({ message: refreshToken }, 401));
    await expect(verifyUser(accessToken, denied)).rejects.toThrow("GH_AUTH_UNAUTHORIZED");
    const http = queued(json({ error: "bad_refresh_token", error_description: refreshToken }));
    await expect(refreshUserToken(clientId, saved, { ...http, now: () => start })).rejects.toThrow(
      "GH_AUTH_REFRESH_REJECTED",
    );
  });
});
