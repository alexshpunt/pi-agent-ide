import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GithubAppAuth } from "#github/auth.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

let directory: string;
let key: string;
const now = Date.parse("2026-10-10T10:00:00Z");
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "github-app-revoke-"));
  key = path.join(directory, "key.pem");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(key, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function create(fetcher: typeof fetch, clock: () => number = () => now): GithubAppAuth {
  return new GithubAppAuth(
    { appId: 123, installationId: 456, privateKeyPath: key },
    { fetcher, coordinator: isolatedCoordinator(), now: clock },
  );
}
function minted(value: string): Response {
  return Response.json({ token: value, expires_at: new Date(now + 3_600_000).toISOString() });
}

it("does not mint a credential when there is no cached installation token", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const auth = new GithubAppAuth(
    { appId: 123, installationId: 456, privateKeyPath: key },
    { fetcher, coordinator: isolatedCoordinator(), now: () => now },
  );
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  expect(fetcher).not.toHaveBeenCalled();
});

it("revokes exactly the cached installation token and clears the cache", async () => {
  const calls: {
    url: string;
    method: string | undefined;
    credential: string | null;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({
      url: fetchUrl(url),
      method: init?.method,
      credential: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : minted("fixture-one");
  };
  const auth = create(fetcher);
  await auth.getToken();
  expect(await auth.revokeCachedToken()).toBe("revoked");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({
    url: "https://api.github.com/installation/token",
    method: "DELETE",
    credential: "Bearer fixture-one",
    redirect: "error",
  });
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  expect(calls).toHaveLength(2);
});

it.each([
  [401, "refused"],
  [403, "refused"],
  [408, "unknown"],
  [429, "refused"],
  [500, "unknown"],
  [200, "unknown"],
] as const)(
  "classifies HTTP %i without exposing the response or replaying",
  async (status, expected) => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("fixture-private-response", { status })
        : minted("fixture-private-token"),
    );
    const auth = create(fetcher);
    await auth.getToken();
    const result = await auth.revokeCachedToken();
    expect(result).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await auth.revokeCachedToken()).toBe("not-cached");
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  },
);

it("treats a dispatched transport failure as unknown and does not leak its content", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") throw new Error("fixture-private-token");
    return minted("fixture-private-token");
  });
  const auth = create(fetcher);
  await auth.getToken();
  expect(await auth.revokeCachedToken()).toBe("unknown");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not send or clear the token when cancellation happens before dispatch", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    init?.method === "DELETE" ? new Response(null, { status: 204 }) : minted("fixture-one"),
  );
  const auth = create(fetcher);
  await auth.getToken();
  expect(await auth.revokeCachedToken(AbortSignal.abort())).toBe("not-sent");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await auth.revokeCachedToken()).toBe("revoked");
});

it("blocks refresh and concurrent revocation while a deletion is in flight", async () => {
  let release!: (response: Response) => void;
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "DELETE") return minted("fixture-one");
    dispatched();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = create(fetcher);
  await auth.getToken();
  const revoke = auth.revokeCachedToken();
  await started;
  expect(await auth.revokeCachedToken()).toBe("not-sent");
  await expect(auth.getToken()).rejects.toThrow("GH_AUTH_REVOKING");
  await expect(auth.initialize()).rejects.toThrow("GH_AUTH_REVOKING");
  release(new Response(null, { status: 204 }));
  expect(await revoke).toBe("revoked");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reports unknown if clear interrupts an already-dispatched revoke", async () => {
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "DELETE") return minted("fixture-one");
    dispatched();
    return new Promise<Response>(() => {});
  });
  const auth = create(fetcher);
  await auth.getToken();
  const revoke = auth.revokeCachedToken();
  await started;
  auth.clear();
  expect(await revoke).toBe("unknown");
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("cannot restore a token from a refresh interrupted by logout", async () => {
  let clock = now;
  let mintCount = 0;
  let release!: (value: Response) => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (++mintCount === 1) return minted("fixture-old");
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = create(fetcher, () => clock);
  await auth.getToken();
  clock += 3_500_000;
  const pending = auth.getToken().catch((error: unknown) => error);
  await refreshing;
  expect(await auth.revokeCachedToken()).toBe("revoked");
  release(minted("fixture-replacement"));
  expect(await pending).toBeInstanceOf(Error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("cancels a pending first mint without minting solely to revoke", async () => {
  let dispatched!: () => void;
  let release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher = vi.fn(async () => {
    dispatched();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = create(fetcher);
  const pending = auth.getToken().catch((error: unknown) => error);
  await started;
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  release(minted("fixture-late"));
  expect(await pending).toBeInstanceOf(Error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await auth.revokeCachedToken()).toBe("not-cached");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
