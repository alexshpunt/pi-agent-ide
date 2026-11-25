/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureRequestUrl, fixtureFormBody, fixtureString } from "./fixtures/http.ts";
import { jsonRecord } from "./fixtures/json.ts";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NamedConnections } from "#axi/named-connections.ts";
import { ManagedConnection } from "#axi/managed-connection.ts";

const who = {
  id: "user",
  name: "Fixture",
  organization: { id: "org", name: "Fixture", urlKey: "fixture" },
};
const fetchImpl: typeof fetch = async (_url, init) =>
  new Response(
    JSON.stringify(
      new Headers(init?.headers).get("authorization") === "bad-key"
        ? { errors: [{ message: "bad" }] }
        : { data: { viewer: who } },
    ),
    { status: new Headers(init?.headers).get("authorization") === "bad-key" ? 401 : 200 },
  );
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "linear-named-"));
  const env = {
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "public-fixture",
  };
  return {
    directory,
    env,
    manager: new NamedConnections({ env, fetchImpl }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("an installed app connects using its existing token without reinstalling, exchanging or changing the default", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const f = await fixture();
  const cachePath = join(f.directory, "existing-app.json");
  const expiresAt = Date.now() + 3600_000;
  const cached = JSON.stringify({ accessToken: "existing-private-app-token", expiresAt });
  await writeFile(cachePath, cached, { mode: 0o600 });
  const calls: string[] = [];
  const manager = new NamedConnections({
    env: { ...f.env, LINEAR_AXI_TOKEN_FILE: cachePath },
    fetchImpl: async (url, init) => {
      calls.push(fixtureRequestUrl(url));
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer existing-private-app-token",
      );
      return new Response(
        JSON.stringify({ data: { viewer: { ...who, id: "installed-app", app: true } } }),
      );
    },
  });
  try {
    const user = await f.manager.importCredential({
      type: "api-key",
      token: "user-key",
      name: "Personal",
    });
    await f.manager.setDefault(fixtureString(user.connectionId));
    const result = await manager.connectInstalledApp({ name: "Installed app" });
    assert.equal(result.actor, "app");
    assert.equal(result.identity?.id, "installed-app");
    assert.equal(result.defaultConnectionId, user.connectionId);
    assert.deepEqual(result.scopes, []);
    assert.equal((await manager.list()).connections.length, 2);
    assert.equal(await readFile(cachePath, "utf8"), cached);
    assert.deepEqual(calls, ["https://api.linear.app/graphql"]);
    assert.equal(JSON.stringify(result).includes("existing-private-app-token"), false);
  } finally {
    await f.cleanup();
  }
});
void test("a missing or expired installed-app token never triggers a new grant or replaces a working connection", async () => {
  const { writeFile } = await import("node:fs/promises");
  for (const expired of [false, true]) {
    const f = await fixture();
    const cachePath = join(f.directory, "existing-app.json");
    if (expired)
      await writeFile(
        cachePath,
        JSON.stringify({ accessToken: "expired-private-app-token", expiresAt: 0 }),
      );
    let calls = 0;
    const manager = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_TOKEN_FILE: cachePath },
      fetchImpl: async () => {
        calls++;
        throw new Error("must not contact Linear");
      },
    });
    try {
      const user = await f.manager.importCredential({
        type: "api-key",
        token: "user-key",
        name: "Personal",
      });
      await f.manager.setDefault(fixtureString(user.connectionId));
      await assert.rejects(
        manager.connectInstalledApp({ name: "Installed app" }),
        /^Error: LINEAR_AUTH_APP_TOKEN_UNAVAILABLE$/,
      );
      assert.equal(calls, 0);
      const listing = await f.manager.list();
      assert.equal(listing.connections.length, 1);
      assert.equal(listing.defaultConnectionId, user.connectionId);
    } finally {
      await f.cleanup();
    }
  }
});
void test("an installed-App connection refuses a cached user token without publishing a profile", async () => {
  const { writeFile } = await import("node:fs/promises");
  const f = await fixture();
  const cachePath = join(f.directory, "not-an-app.json");
  await writeFile(
    cachePath,
    JSON.stringify({ accessToken: "private-user-token", expiresAt: Date.now() + 3600_000 }),
  );
  const manager = new NamedConnections({
    env: { ...f.env, LINEAR_AXI_TOKEN_FILE: cachePath },
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: { viewer: { ...who, app: false } } })),
  });
  try {
    await assert.rejects(
      manager.connectInstalledApp({ name: "Must not save" }),
      /^Error: LINEAR_AUTH_APP_REQUIRED$/,
    );
    assert.deepEqual((await manager.list()).connections, []);
  } finally {
    await f.cleanup();
  }
});
void test("several named keys can be added without logout and a failed addition preserves the selected key", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.importCredential({ type: "api-key", token: "key-a", name: "Work" });
    const b = await f.manager.importCredential({
      type: "api-key",
      token: "key-b",
      name: "Personal",
    });
    assert.notEqual(a.connectionId, b.connectionId);
    assert.equal(await f.manager.authorization(), "key-b");
    await assert.rejects(
      f.manager.importCredential({ type: "api-key", token: "bad-key", name: "Invalid" }),
      /LINEAR_AUTH_INVALID_CREDENTIAL/,
    );
    assert.equal(await f.manager.authorization(), "key-b");
    const list = await f.manager.list();
    assert.equal(list.connections.length, 2);
    assert.deepEqual(
      list.connections.map((row) => row.name),
      ["Work", "Personal"],
    );
    assert.equal(JSON.stringify(list).includes("key-a"), false);
    assert.equal(JSON.stringify(list).includes("key-b"), false);
    assert.equal(list.defaultConnectionId, null);
  } finally {
    await f.cleanup();
  }
});

void test("session selections are independent from the explicitly assigned new-session default", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.importCredential({ type: "api-key", token: "key-a", name: "A" });
    const b = await f.manager.importCredential({ type: "api-key", token: "key-b", name: "B" });
    await f.manager.setDefault(fixtureString(a.connectionId));
    const first = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId },
      fetchImpl,
    });
    const second = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_CONNECTION_ID: b.connectionId },
      fetchImpl,
    });
    await first.select(fixtureString(b.connectionId));
    assert.equal(await first.authorization(), "key-b");
    assert.equal(await second.authorization(), "key-b");
    assert.equal(await new NamedConnections({ env: f.env, fetchImpl }).authorization(), "key-a");
    await f.manager.rename(fixtureString(a.connectionId), "Work renamed");
    assert.equal(
      (await new NamedConnections({ env: f.env, fetchImpl }).status()).name,
      "Work renamed",
    );
  } finally {
    await f.cleanup();
  }
});

void test("logout removes the selected profile across sessions and never falls back to another default", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.importCredential({ type: "api-key", token: "key-a", name: "A" });
    const b = await f.manager.importCredential({ type: "api-key", token: "key-b", name: "B" });
    await f.manager.setDefault(fixtureString(b.connectionId));
    const other = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId },
      fetchImpl,
    });
    await f.manager.select(fixtureString(a.connectionId));
    await f.manager.logout();
    await assert.rejects(other.authorization(), /LINEAR_AUTH_CONNECTION_REMOVED/);
    assert.equal((await other.list()).connections.length, 1);
    assert.equal(await new NamedConnections({ env: f.env, fetchImpl }).authorization(), "key-b");
    const none = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_CONNECTION_ID: "none" },
      fetchImpl,
    });
    await assert.rejects(none.authorization(), /LINEAR_AUTH_REQUIRED/);
    await f.manager.select(fixtureString(b.connectionId));
    await f.manager.logout();
    assert.equal((await f.manager.list()).defaultConnectionId, null);
    assert.equal(
      (await new NamedConnections({ env: f.env, fetchImpl }).status()).state,
      "signed-out",
    );
  } finally {
    await f.cleanup();
  }
});

void test("the current single credential migrates once to a private named default without re-entry", async () => {
  const f = await fixture();
  try {
    await new ManagedConnection({ env: f.env, fetchImpl }).importCredential({
      type: "api-key",
      token: "legacy-key",
    });
    const [left, right] = await Promise.all([
      f.manager.list(),
      new NamedConnections({ env: f.env, fetchImpl }).list(),
    ]);
    assert.equal(left.connections.length, 1);
    assert.equal(right.connections[0]?.connectionId, left.connections[0]?.connectionId);
    assert.equal(left.defaultConnectionId, left.connections[0]?.connectionId);
    assert.equal(await f.manager.authorization(), "legacy-key");
    assert.equal((await stat(f.manager.catalogPath)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(left).includes("legacy-key"), false);
  } finally {
    await f.cleanup();
  }
});

function callback(start: { url: string; redirectUri: string }, code: string) {
  const url = new URL(start.redirectUri);
  url.searchParams.set("state", fixtureString(new URL(start.url).searchParams.get("state")));
  url.searchParams.set("code", code);
  return { callbackUrl: url.href };
}

void test("separate pending OAuth logins and cancellation do not disturb the selected key", async () => {
  const f = await fixture();
  try {
    const remote: typeof fetch = async (url, init) =>
      fixtureRequestUrl(url).endsWith("/oauth/token")
        ? new Response(
            JSON.stringify({
              access_token: "oauth-" + fixtureFormBody(init).get("code"),
              refresh_token: "fixture-refresh",
              expires_in: 86400,
              scope: "read",
            }),
          )
        : fetchImpl(url, init);
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const a = await manager.importCredential({ type: "api-key", token: "key-a", name: "Key" });
    const one = await manager.beginLogin({ actor: "user", method: "oauth", name: "Browser one" });
    const two = await manager.beginLogin({ actor: "app", method: "oauth", name: "Browser two" });
    assert.equal(await manager.authorization(), "key-a");
    await manager.cancelLogin(one.epoch);
    assert.equal(await manager.authorization(), "key-a");
    await assert.rejects(
      manager.finishLogin(callback(one, "denied")),
      /LINEAR_AUTH_NO_PENDING_LOGIN/,
    );
    const b = await manager.finishLogin(callback(two, "two"));
    assert.equal(b.method, "app-oauth");
    assert.equal((await manager.list()).connections.length, 2);
    assert.equal(
      await new NamedConnections({
        env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId },
        fetchImpl: remote,
      }).authorization(),
      "key-a",
    );
    assert.equal(await manager.authorization(), "Bearer oauth-two");
  } finally {
    await f.cleanup();
  }
});

void test("concurrent refresh uses the grant lock and preserves other profiles and selection epochs", async () => {
  const f = await fixture();
  try {
    let refreshes = 0;
    const remote: typeof fetch = async (url, init) => {
      if (!fixtureRequestUrl(url).endsWith("/oauth/token")) return fetchImpl(url, init);
      const refreshing = fixtureFormBody(init).get("grant_type") === "refresh_token";
      if (refreshing) {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return new Response(
        JSON.stringify({
          access_token: refreshing ? "rotated-access" : "first-access",
          refresh_token: refreshing ? "rotated-refresh" : "first-refresh",
          expires_in: refreshing ? 86400 : 1,
          scope: "read",
        }),
      );
    };
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const a = await manager.importCredential({ type: "api-key", token: "key-a", name: "Key" });
    const start = await manager.beginLogin({ actor: "user", method: "oauth", name: "Browser" });
    const b = await manager.finishLogin(callback(start, "browser"));
    const env = { ...f.env, LINEAR_AXI_CONNECTION_ID: b.connectionId };
    const [left, right] = await Promise.all([
      new NamedConnections({ env, fetchImpl: remote }).authorization(),
      new NamedConnections({ env, fetchImpl: remote }).authorization(),
    ]);
    assert.deepEqual([left, right], ["Bearer rotated-access", "Bearer rotated-access"]);
    assert.equal(refreshes, 1);
    const list = await manager.list();
    assert.equal(
      list.connections.find((row) => row.connectionId === a.connectionId)?.epoch,
      a.epoch,
    );
    assert.equal(
      list.connections.find((row) => row.connectionId === b.connectionId)?.epoch,
      b.epoch,
    );
    assert.equal(
      await new NamedConnections({
        env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId },
        fetchImpl: remote,
      }).authorization(),
      "key-a",
    );
  } finally {
    await f.cleanup();
  }
});

void test("unknown revocation retires only the selected profile and does not replay or erase another key", async () => {
  const f = await fixture();
  try {
    let revocations = 0;
    const remote: typeof fetch = async (url, init) => {
      if (fixtureRequestUrl(url).endsWith("/oauth/token"))
        return new Response(
          JSON.stringify({
            access_token: "app-access",
            refresh_token: "app-refresh",
            expires_in: 86400,
            scope: "read",
          }),
        );
      if (fixtureRequestUrl(url).endsWith("/oauth/revoke")) {
        revocations++;
        throw new Error("synthetic delivery loss");
      }
      return fetchImpl(url, init);
    };
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const a = await manager.importCredential({ type: "api-key", token: "key-a", name: "Key" });
    const start = await manager.beginLogin({ actor: "app", method: "oauth", name: "App" });
    const b = await manager.finishLogin(callback(start, "app"));
    await manager.setDefault(fixtureString(b.connectionId));
    await assert.rejects(manager.revoke(), /LINEAR_AUTH_REVOKE_UNKNOWN/);
    assert.equal(revocations, 1);
    const list = await manager.list();
    assert.equal(list.connections.length, 1);
    assert.equal(list.defaultConnectionId, null);
    await assert.rejects(manager.authorization(), /LINEAR_AUTH_CONNECTION_REMOVED/);
    assert.equal(
      await new NamedConnections({
        env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId },
        fetchImpl: remote,
      }).authorization(),
      "key-a",
    );
  } finally {
    await f.cleanup();
  }
});
void test("ordinary revocation refusal retains the named connection", async () => {
  const f = await fixture();
  const remote: typeof fetch = async (url, init) =>
    fixtureRequestUrl(url).endsWith("/oauth/revoke")
      ? new Response("", { status: 400 })
      : fetchImpl(url, init);
  try {
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const selected = await manager.importCredential({
      type: "oauth",
      token: "oauth-a",
      name: "Selected",
    });
    const { managedAuthCommand } = await import("#axi/commands/managed-auth.ts");
    await assert.rejects(
      managedAuthCommand(["revoke"], { env: f.env, connection: manager }),
      /LINEAR_AUTH_REVOKE_REFUSED/,
    );
    assert.equal(
      (await manager.list()).connections.find((row) => row.connectionId === selected.connectionId)
        ?.state,
      "connected",
    );
  } finally {
    await f.cleanup();
  }
});
void test("logout revocation refusal forgets only the selected grant and reports refusal", async () => {
  const f = await fixture();
  const remote: typeof fetch = async (url, init) =>
    fixtureRequestUrl(url).endsWith("/oauth/revoke")
      ? new Response("", { status: 400 })
      : fetchImpl(url, init);
  try {
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const other = await manager.importCredential({
      type: "api-key",
      token: "key-a",
      name: "Other",
    });
    const selected = await manager.importCredential({
      type: "oauth",
      token: "oauth-a",
      name: "Logout",
    });
    await manager.setDefault(fixtureString(selected.connectionId));
    const { managedAuthCommand } = await import("#axi/commands/managed-auth.ts");
    await assert.rejects(
      managedAuthCommand(["revoke", "--forget-on-refusal"], { env: f.env, connection: manager }),
      /LINEAR_AUTH_REVOKE_REFUSED/,
    );
    const list = await manager.list();
    assert.deepEqual(
      list.connections.map((row) => row.connectionId),
      [other.connectionId],
    );
    assert.equal(list.defaultConnectionId, null);
    assert.equal(
      await new NamedConnections({
        env: { ...f.env, LINEAR_AXI_CONNECTION_ID: other.connectionId },
        fetchImpl: remote,
      }).authorization(),
      "key-a",
    );
  } finally {
    await f.cleanup();
  }
});

void test("refused logout revocation cannot forget a concurrent replacement", async () => {
  const f = await fixture();
  let selectedId = "";
  const remote: typeof fetch = async (url, init) => {
    if (fixtureRequestUrl(url).endsWith("/oauth/revoke")) {
      const replacement = new ManagedConnection({
        env: {
          ...f.env,
          LINEAR_AXI_CONNECTION_FILE: `${f.env.LINEAR_AXI_CONNECTION_FILE}.connections/${selectedId}.json`,
        },
        fetchImpl,
      });
      await replacement.importCredential({ type: "api-key", token: "key-b" });
      return new Response("", { status: 400 });
    }
    return fetchImpl(url, init);
  };
  try {
    const manager = new NamedConnections({ env: f.env, fetchImpl: remote });
    const selected = await manager.importCredential({
      type: "oauth",
      token: "oauth-a",
      name: "Selected",
    });
    selectedId = fixtureString(selected.connectionId);
    const { managedAuthCommand } = await import("#axi/commands/managed-auth.ts");
    await assert.rejects(
      managedAuthCommand(["revoke", "--forget-on-refusal"], { env: f.env, connection: manager }),
      /LINEAR_AUTH_REVOKE_REFUSED/,
    );
    const list = await manager.list();
    assert.equal(
      list.connections.find((row) => row.connectionId === selectedId)?.credentialType,
      "api-key",
    );
    assert.equal(
      await new NamedConnections({
        env: { ...f.env, LINEAR_AXI_CONNECTION_ID: selectedId },
        fetchImpl,
      }).authorization(),
      "key-b",
    );
  } finally {
    await f.cleanup();
  }
});
void test("a full catalog rejects an addition before it can make a working connection unreadable", async () => {
  const f = await fixture();
  try {
    await f.manager.importCredential({ type: "api-key", token: "key-a", name: "Work" });
    const { readFile, writeFile } = await import("node:fs/promises");
    const catalog = jsonRecord(await readFile(f.manager.catalogPath, "utf8"));
    // Simulate a valid near-capacity catalog without hundreds of browser exchanges.
    catalog.padding = "";
    const padding = 128 * 1024 - 64 - Buffer.byteLength(JSON.stringify(catalog) + "\n");
    catalog.padding = "x".repeat(padding);
    const before = JSON.stringify(catalog) + "\n";
    await writeFile(f.manager.catalogPath, before, { mode: 0o600 });
    await assert.rejects(
      f.manager.importCredential({
        type: "api-key",
        token: "key-b",
        name: "Another connection with enough metadata to exceed the remaining capacity",
      }),
      /LINEAR_AUTH_STORE_FULL/,
    );
    assert.equal(await readFile(f.manager.catalogPath, "utf8"), before);
    assert.equal(await f.manager.authorization(), "key-a");
  } finally {
    await f.cleanup();
  }
});

void test("expired pending OAuth attempts release their name without changing the selected key", async (t) => {
  const f = await fixture();
  try {
    await f.manager.importCredential({ type: "api-key", token: "key-a", name: "Work" });
    const old = await f.manager.beginLogin({ actor: "user", method: "oauth", name: "Browser" });
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 11 * 60_000);
    const next = await f.manager.beginLogin({ actor: "user", method: "oauth", name: "Browser" });
    assert.notEqual(next.epoch, old.epoch);
    assert.equal(await f.manager.authorization(), "key-a");
    await assert.rejects(
      f.manager.finishLogin(callback(old, "old")),
      /LINEAR_AUTH_NO_PENDING_LOGIN/,
    );
    await f.manager.cancelLogin(next.epoch);
    assert.equal((await f.manager.list()).connections.length, 1);
  } finally {
    await f.cleanup();
  }
});
void test("deleting a connection invalidates a pinned in-flight principal even if another key remains", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.importCredential({ type: "api-key", token: "key-a", name: "A" });
    const pinned = new NamedConnections({
      env: { ...f.env, LINEAR_AXI_CONNECTION_ID: a.connectionId, LINEAR_AXI_AUTH_EPOCH: a.epoch },
      fetchImpl,
    });
    assert.equal(await pinned.authorization(), "key-a");
    await f.manager.logout();
    await f.manager.importCredential({ type: "api-key", token: "key-b", name: "B" });
    await assert.rejects(
      pinned.authorization(),
      /LINEAR_AUTH_CONNECTION_REMOVED|LINEAR_AUTH_CONTEXT_CHANGED/,
    );
  } finally {
    await f.cleanup();
  }
});
