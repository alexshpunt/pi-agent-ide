import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { describe, expect, it } from "vitest";
import { GithubConnections } from "#github/connections/manager.ts";
import { MemoryStore } from "./fixtures/memory-connections.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

async function setup() {
  const store = new MemoryStore();
  for (const id of ["personal", "work", "other"]) {
    await store.saveProfile(
      { id, label: id, kind: "pat" },
      { kind: "pat", token: `private-${id}` },
    );
  }
  await store.setProjectDefault("/project", "personal");
  const requests: { route: string; authorization: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const route = new URL(fetchUrl(input)).pathname;
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ route, authorization });
    const login = authorization?.slice("Bearer private-".length) ?? "unknown";
    return new Response(
      JSON.stringify(route === "/user" ? { id: 42, login, name: login } : { login }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { store, requests, fetcher };
}

describe("session GitHub connections", () => {
  it("shares an upstream user's quota across profiles without sharing credential ownership", async () => {
    const { store } = await setup();
    const coordinator = isolatedCoordinator();
    let requests = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      return new URL(fetchUrl(input)).pathname === "/user"
        ? Response.json({ id: 123, login: "upstream", type: "User" })
        : new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    };
    const first = new GithubConnections({ store, fetcher, coordinator });
    const second = new GithubConnections({ store, fetcher, coordinator });
    try {
      first.useProfile("personal");
      second.useProfile("work");
      const a = await first.capture("/project");
      const b = await second.capture("/project");
      await Promise.all([a.credentials.initialize(), b.credentials.initialize()]);
      expect(a.credentials.quotaOwner).toBe("user:upstream");
      expect(b.credentials.quotaOwner).toBe(a.credentials.quotaOwner);
      expect(a.key).not.toBe(b.key);
      await expect(a.client.rest("GET", "/repos/a/b")).rejects.toMatchObject({
        code: "GH_RATE_LIMITED",
      });
      await expect(b.client.rest("GET", "/repos/a/b")).rejects.toMatchObject({
        code: "GH_RATE_LIMITED",
        effect: "not-applied",
      });
      expect(requests).toBe(3);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("retires a queued mutation before it reaches the HTTP boundary", async () => {
    const { store, fetcher: identity } = await setup();
    let release!: () => void;
    let started!: () => void;
    let writes = 0;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(fetchUrl(input)).pathname === "/user") return identity(input, init);
      if (init?.method === "POST") {
        writes++;
        return Response.json({ id: 1 });
      }
      started();
      await held;
      return Response.json({ id: 1 });
    };
    const connections = new GithubConnections({
      store,
      fetcher,
      coordinator: isolatedCoordinator(),
    });
    try {
      const access = await connections.capture("/project");
      await access.credentials.initialize();
      const read = access.client.rest("GET", "/repos/a/b").catch((error: unknown) => error);
      await ready;
      const pending = access.client
        .rest("POST", "/repos/a/b/issues", { title: "not sent" })
        .catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      connections.useProfile("work");
      expect(await pending).toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
      release();
      await read;
      expect(writes).toBe(0);
    } finally {
      release();
      connections.dispose();
    }
  });
  it("passes only App credentials, not profile metadata, to the existing App authenticator", async () => {
    const { store, fetcher } = await setup();
    await store.saveProfile({
      id: "bot",
      label: "My bot",
      kind: "app",
      appId: 123,
      installationId: 456,
      privateKeyPath: "/not-opened.pem",
    });
    await store.setProjectDefault("/app-project", "bot");
    const connections = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    expect((await connections.capture("/app-project")).profile.id).toBe("bot");
    connections.dispose();
  });
  it("uses the selected token and verifies the actual user", async () => {
    const { store, requests, fetcher } = await setup();
    const connections = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    const access = await connections.capture("/project");
    await access.client.rest("GET", "/repos/example/project");
    expect(access.client.identity.login).toBe("personal");
    expect(requests.every((request) => request.authorization === "Bearer private-personal")).toBe(
      true,
    );
    connections.dispose();
  });

  it("pins project defaults in running sessions and keeps overrides independent", async () => {
    const { store, fetcher } = await setup();
    const first = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    const second = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    expect((await first.capture("/project")).profile.id).toBe("personal");
    expect((await second.capture("/project")).profile.id).toBe("personal");
    first.useProfile("work");
    expect((await first.capture("/project")).profile.id).toBe("work");
    expect((await second.capture("/project")).profile.id).toBe("personal");
    await store.setProjectDefault("/project", "other");
    expect((await second.capture("/project")).profile.id).toBe("personal");
    const fresh = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    expect((await fresh.capture("/project")).profile.id).toBe("other");
    first.dispose();
    second.dispose();
    fresh.dispose();
  });

  it("uses a global default for new sessions without overriding project defaults or active sessions", async () => {
    const { store, fetcher } = await setup();
    await store.setGlobalDefault("personal");
    const create = () =>
      new GithubConnections({
        coordinator: isolatedCoordinator(),
        store,
        fetcher,
        legacyConfig: async () => undefined,
      });
    const first = create();
    try {
      expect((await first.capture("/without-default")).profile.id).toBe("personal");
      await store.setGlobalDefault("work");
      expect((await first.capture("/another-project")).profile.id).toBe("personal");
      expect((await first.capture("/project")).profile.id).toBe("personal");
      const fresh = create();
      try {
        expect((await fresh.capture("/without-default")).profile.id).toBe("work");
        expect((await fresh.capture("/project")).profile.id).toBe("personal");
        fresh.useProfile("other");
        expect((await fresh.capture("/project")).profile.id).toBe("other");
        expect((await first.capture("/without-default")).profile.id).toBe("personal");
      } finally {
        fresh.dispose();
      }
    } finally {
      first.dispose();
    }
  });
  it("uses a newly selected global account in projects with an older default without changing existing sessions", async () => {
    const { store, fetcher } = await setup();
    await store.setGlobalDefault("personal");
    const create = () =>
      new GithubConnections({
        coordinator: isolatedCoordinator(),
        store,
        fetcher,
        legacyConfig: async () => undefined,
      });
    const existing = create();
    const before = await existing.capture("/project");
    expect(before.profile.id).toBe("personal");
    await store.setGlobalDefaultForNewSessions("work");
    expect((await existing.capture("/project")).profile.id).toBe("personal");
    expect((await existing.capture("/another-project")).profile.id).toBe("personal");
    expect(await store.getProjectDefault("/project")).toBe("personal");
    const fresh = create();
    try {
      expect((await fresh.capture("/project")).profile.id).toBe("work");
      expect((await fresh.capture("/another-project")).profile.id).toBe("work");
      fresh.useProfile("other");
      expect((await fresh.capture("/project")).profile.id).toBe("other");
    } finally {
      existing.dispose();
      fresh.dispose();
    }
  });
  it("does not import project configuration while a preferred global account is in use", async () => {
    const { store, fetcher } = await setup();
    await store.setGlobalDefaultForNewSessions("work");
    let imports = 0;
    const session = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => {
        imports++;
        return { appId: 1, installationId: 2, privateKeyPath: "/fixture.pem" };
      },
    });
    try {
      expect((await session.capture("/untouched-project")).profile.id).toBe("work");
      expect(imports).toBe(0);
      expect(await store.getProjectDefault("/untouched-project")).toBeUndefined();
    } finally {
      session.dispose();
    }
  });
  it("does not fall back to a new global default when the pinned connection is removed", async () => {
    const { store, fetcher } = await setup();
    await store.setGlobalDefault("personal");
    const session = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    try {
      expect((await session.capture("/one")).profile.id).toBe("personal");
      await store.removeProfile("personal");
      await store.setGlobalDefault("work");
      await expect(session.capture("/two")).rejects.toThrow("GH_CONNECTION_MISSING");
    } finally {
      session.dispose();
    }
  });
  it("retires old guards and clients before another profile can send a request", async () => {
    const { store, requests, fetcher } = await setup();
    const connections = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => undefined,
    });
    const old = await connections.capture("/project");
    await old.client.rest("GET", "/user");
    const count = requests.length;
    connections.useProfile("work");
    expect(() => old.assertCurrent()).toThrow("GH_CONNECTION_CHANGED");
    await expect(
      old.client.rest("POST", "/repos/example/project/issues", { title: "not sent" }),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
    expect(requests).toHaveLength(count);
    const current = await connections.capture("/project");
    expect(current.owner).not.toBe(old.owner);
    expect(current.key).not.toBe(old.key);
    connections.dispose();
  });

  it("does not fall back to an App when an explicitly selected profile is missing", async () => {
    const { store, fetcher } = await setup();
    let legacyCalls = 0;
    const connections = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher,
      legacyConfig: async () => {
        legacyCalls++;
        return { appId: 1, installationId: 2, privateKeyPath: "/not-used.pem" };
      },
    });
    connections.useProfile("removed-profile");
    await expect(connections.capture("/project")).rejects.toThrow("GH_CONNECTION_MISSING");
    expect(legacyCalls).toBe(0);
    connections.dispose();
  });

  it("aborts an in-flight mutation on switch and never replays it", async () => {
    const { store, fetcher } = await setup();
    let writes = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return fetcher(input, init);
      writes++;
      started();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("cancelled", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const connections = new GithubConnections({
      coordinator: isolatedCoordinator(),
      store,
      fetcher: transport,
      legacyConfig: async () => undefined,
    });
    const old = await connections.capture("/project");
    const result = old.client
      .rest("POST", "/repos/example/project/issues", { title: "one" })
      .catch((error: unknown) => error);
    await ready;
    connections.useProfile("work");
    expect(await result).toMatchObject({ code: "GH_CANCELLED", effect: "unknown" });
    expect(writes).toBe(1);
    expect((await connections.capture("/project")).profile.id).toBe("work");
    connections.dispose();
  });
});
