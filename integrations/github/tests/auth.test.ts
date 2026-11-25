import { GithubRateLimitError } from "#github/rate-limit.ts";
import { githubPackageRoot } from "./fixtures/package-root.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppAuth, GithubAppRegistration, type AppConfig } from "#github/auth.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
const now = Date.parse("2026-10-10T10:00:00Z");
let directory: string;
let config: AppConfig;

beforeEach(async () => {
  await mkdir(path.join(githubPackageRoot, ".tmp"), { recursive: true });
  directory = await mkdtemp(path.join(githubPackageRoot, ".tmp/auth-"));
  const key = path.join(directory, "app.pem");
  await writeFile(key, pem, { mode: 0o600 });
  config = { appId: 123, installationId: 456, privateKeyPath: key };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function token(sequence = 1): Response {
  return reply({
    token: "installation-secret-" + sequence,
    expires_at: new Date(now + sequence * 3_600_000).toISOString(),
  });
}
function api() {
  let mints = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const route = new URL(fetchUrl(input)).pathname;
    const auth = new Headers(options?.headers).get("authorization");
    if (auth === null) throw new Error("Expected App credentials");
    expect(options?.redirect).toBe("error");
    if (route === "/app" || route.endsWith("/access_tokens")) {
      const jwt = auth.slice("Bearer ".length).split(".");
      const [, claimsSegment, signature] = jwt;
      if (!claimsSegment || !signature) throw new Error("Expected signed JWT");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(jwt.slice(0, 2).join(".")),
          pair.publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString()) as {
        iss: string;
        exp: number;
        iat: number;
      };
      expect(claims.iss).toBe("123");
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
      return route === "/app" ? reply({ id: 123, slug: "example-agent" }) : token(++mints);
    }
    expect(route).toBe("/users/example-agent%5Bbot%5D");
    expect(auth).toBe("Bearer installation-secret-1");
    return reply({ id: 789, login: "example-agent[bot]" });
  });
  return { fetcher: fetcher as typeof fetch, calls: fetcher };
}

describe("GitHub App authorization", () => {
  it("shares JWT authorization cooldown across installation selection and token minting", async () => {
    const coordinator = isolatedCoordinator();
    const fetcher = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
    );
    const options = { coordinator, fetcher };
    const auth = new GithubAppAuth(config, options);
    const first = await auth.getToken().catch((error: unknown) => error);
    const registration = new GithubAppRegistration(
      { appId: config.appId, privateKeyPath: config.privateKeyPath },
      options,
    );
    const blocked = await registration.listInstallations().catch((error: unknown) => error);
    const anotherInstallation = new GithubAppAuth({ ...config, installationId: 999 }, options);
    const alsoBlocked = await anotherInstallation.getToken().catch((error: unknown) => error);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const error of [first, blocked, alsoBlocked]) {
      expect(error).toMatchObject({ code: "GH_RATE_LIMITED", effect: "not-applied" });
      if (!(error instanceof GithubRateLimitError)) throw new Error("Expected a rate limit");
      expect(error.rateLimit.resetAt).toBeGreaterThan(Date.now());
    }
    await new GithubAppAuth({ ...config, appId: 124 }, options).getToken().catch(() => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("handles clear during fetch without an unhandled credential-bearing rejection", async () => {
    let auth!: GithubAppAuth;
    const fetcher = (async () => {
      auth.clear();
      throw new Error("synthetic-private-fetch-failure");
    }) as typeof fetch;
    auth = new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher });
    await expect(auth.getToken()).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("does not wait for a stalled cancellation of an oversized auth response", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65_537));
            },
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
        ),
    ) as typeof fetch;
    await expect(
      new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
    ).rejects.toThrow("unreadable");
  }, 1000);
  it("signs App requests and verifies the current bot instead of a hardcoded name", async () => {
    const { fetcher } = api();
    const auth = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => now,
    });
    expect(() => auth.identity).toThrow("not ready");
    await auth.initialize();
    expect(auth.identity).toEqual({
      login: "example-agent[bot]",
      name: "example-agent[bot]",
      email: "789+example-agent[bot]@users.noreply.github.com",
    });
  });

  it("shares token refresh and refreshes two minutes before expiry", async () => {
    let time = now;
    const { fetcher, calls } = api();
    const auth = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => time,
    });
    const first = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect(first.map((value) => value.token)).toEqual(Array(3).fill("installation-secret-1"));
    expect(calls).toHaveBeenCalledTimes(1);
    time += 3_470_000;
    expect((await auth.getToken()).token).toBe("installation-secret-1");
    time += 20_000;
    expect((await auth.getToken()).token).toBe("installation-secret-2");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe key permissions, symlinks and invalid keys before a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await chmod(config.privateKeyPath, 0o644);
    await expect(
      new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
    ).rejects.toThrow("private key");
    await chmod(config.privateKeyPath, 0o600);
    const link = path.join(directory, "link.pem");
    await symlink(config.privateKeyPath, link);
    await expect(
      new GithubAppAuth(
        { ...config, privateKeyPath: link },
        { coordinator: isolatedCoordinator(), fetcher },
      ).getToken(),
    ).rejects.toThrow("private key");
    await writeFile(config.privateKeyPath, "not-a-private-key");
    await expect(
      new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
    ).rejects.toThrow("private key");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writeFile(config.privateKeyPath, ec.privateKey.export({ format: "pem", type: "pkcs8" }));
    await expect(
      new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
    ).rejects.toThrow("private key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a FIFO App key without waiting for a writer", async () => {
    await rm(config.privateKeyPath);
    execFileSync("mkfifo", ["-m", "600", config.privateKeyPath]);
    const fetcher = vi.fn<typeof fetch>();
    let neededRescue = false;
    const unblock = setTimeout(() => {
      neededRescue = true;
      void open(config.privateKeyPath, constants.O_WRONLY | constants.O_NONBLOCK)
        .then((file) => file.close())
        .catch(() => {});
    }, 1500);
    try {
      await expect(
        new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
      ).rejects.toThrow("private key");
      expect(neededRescue).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      clearTimeout(unblock);
    }
  });
  it("refuses hard-linked App keys before contacting GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const alias = path.join(directory, "another-key-name.pem");
    await link(config.privateKeyPath, alias);
    await expect(
      new GithubAppAuth(config, { coordinator: isolatedCoordinator(), fetcher }).getToken(),
    ).rejects.toThrow("private key");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an App or bot identity that does not match the configured App", async () => {
    const mismatchedApp = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher: vi.fn(async () => reply({ id: 999, slug: "other-app" })),
    });
    await expect(mismatchedApp.initialize()).rejects.toThrow("identity");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const route = new URL(fetchUrl(input)).pathname;
      if (route === "/app") return reply({ id: 123, slug: "example-agent" });
      if (route.endsWith("/access_tokens")) return token();
      return reply({ id: 789, login: "human-account" });
    }) as typeof fetch;
    const mismatchedBot = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => now,
    });
    await expect(mismatchedBot.initialize()).rejects.toThrow("bot");
    expect(() => mismatchedBot.identity).toThrow("not ready");
  });

  it("never includes credentials or server/transport error bodies in failures", async () => {
    const secret = "secret-from-github";
    for (const fetcher of [
      vi.fn(async () => reply({ token: secret, message: secret }, 403)) as typeof fetch,
      vi.fn(async () => {
        throw new Error(secret);
      }),
      vi.fn(async () => reply({ token: secret, expires_at: "invalid" })),
    ]) {
      const error = await new GithubAppAuth(config, {
        coordinator: isolatedCoordinator(),
        fetcher,
        now: () => now,
      })
        .getToken()
        .catch((value: Error) => value);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.toString() : error).not.toContain(secret);
      expect(error instanceof Error ? error.toString() : error).not.toContain("Bearer");
    }
  });

  it("does not make requests for a cancelled caller, including with cached credentials", async () => {
    const { fetcher, calls } = api();
    const auth = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => now,
    });
    const controller = new AbortController();
    controller.abort("secret-reason");
    await expect(auth.getToken(controller.signal)).rejects.toThrow("cancelled");
    expect(calls).not.toHaveBeenCalled();
    await auth.getToken();
    await expect(auth.getToken(controller.signal)).rejects.toThrow("cancelled");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("cancels one waiter without breaking a concurrent token request", async () => {
    let resolve!: (response: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((done) => {
      began = done;
    });
    const response = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(async () => {
      began();
      return response;
    }) as typeof fetch;
    const auth = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => now,
    });
    const controller = new AbortController();
    const cancelled = auth.getToken(controller.signal);
    const surviving = auth.getToken();
    await started;
    controller.abort("secret-reason");
    await expect(cancelled).rejects.toThrow("cancelled");
    resolve(token());
    expect((await surviving).token).toBe("installation-secret-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears cached identity and prevents an old request from repopulating credentials", async () => {
    const { fetcher } = api();
    const auth = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher,
      now: () => now,
    });
    await auth.initialize();
    auth.clear();
    expect(() => auth.identity).toThrow("not ready");

    let resolve!: (response: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((done) => {
      began = done;
    });
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    let calls = 0;
    const slow = new GithubAppAuth(config, {
      coordinator: isolatedCoordinator(),
      fetcher: vi.fn(async () => {
        began();
        return ++calls === 1 ? pending : token(2);
      }),
      now: () => now,
    });
    const tokenRequest = slow.getToken();
    await started;
    slow.clear();
    resolve(token());
    await expect(tokenRequest).rejects.toThrow("cancelled");
    expect(() => slow.identity).toThrow("not ready");
    expect((await slow.getToken()).token).toBe("installation-secret-2");
    expect(calls).toBe(2);
  });
});
