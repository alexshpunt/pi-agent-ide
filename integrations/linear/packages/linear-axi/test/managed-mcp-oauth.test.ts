/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedConnection } from "#axi/managed-connection.ts";
import { LinearAppTokenProvider } from "#axi/app-token.ts";
import { LinearMcpClient } from "#axi/mcp.ts";
import { LinearStorageClient } from "#axi/storage.ts";
import { managedAuthCommand } from "#axi/commands/managed-auth.ts";
import { createServer } from "node:http";
import { asRecord } from "#axi/types.ts";
import { deferred, fixtureCallbackUrl, fixtureRequestUrl, fixtureString } from "./fixtures/http.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";

const origin = "https://mcp.linear.app";
const viewer = { id: "user-a", name: "Fixture A", email: "a@example.test" };
const workspace = { id: "org-a", name: "Fixture", url: "https://linear.app/fixture" };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function fixture(
  options: {
    native?: boolean;
    expiry?: number;
    omitRefreshExpiry?: boolean;
    broaden?: boolean;
    issuer?: string;
    beforeRegister?: () => Promise<void>;
    redirectUri?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "linear-managed-mcp-"));
  const env = {
    PI_CODING_AGENT_DIR: directory,
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_MCP_TOKEN: "ambient-must-not-be-used",
    LINEAR_AXI_OAUTH_REDIRECT_URI: options.redirectUri,
  };
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  let refreshes = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = fixtureRequestUrl(input);
    const authorization = new Headers(init?.headers).get("authorization");
    const body =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : fixtureString(init?.body ?? "");
    let decoded: Record<string, unknown>;
    try {
      decoded = jsonRecord(body);
    } catch {
      decoded = Object.fromEntries(new URLSearchParams(body));
    }
    calls.push({ url, body: decoded, authorization });
    if (url === "https://api.linear.app/graphql")
      return options.native
        ? json({
            data: {
              viewer: {
                ...viewer,
                organization: { id: workspace.id, name: workspace.name, urlKey: "fixture" },
              },
            },
          })
        : json({ error: "fixture-native-not-supported" }, 401);
    if (url.includes("/.well-known/oauth-protected-resource"))
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [options.issuer ?? origin],
        scopes_supported: ["read", "write"],
      });
    if (url.includes("/.well-known/oauth-authorization-server"))
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ["read", "write"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        revocation_endpoint: `${origin}/token`,
      });
    if (url === `${origin}/register`) {
      await options.beforeRegister?.();
      return json({ ...decoded, client_id: "dynamic-public-fixture", client_id_issued_at: 1 }, 201);
    }
    if (url === `${origin}/token`) {
      if (decoded.grant_type === "refresh_token") refreshes++;
      return json({
        access_token:
          decoded.grant_type === "refresh_token" ? "mcp-refreshed-fixture" : "mcp-access-fixture",
        refresh_token: "mcp-refresh-fixture",
        token_type: "Bearer",
        scope: options.broaden ? "read write" : "read",
        ...(decoded.grant_type === "refresh_token" && options.omitRefreshExpiry
          ? {}
          : {
              expires_in:
                decoded.grant_type === "refresh_token" ? 86400 : (options.expiry ?? 86400),
            }),
      });
    }
    if (url === `${origin}/mcp` && init?.method === "POST") {
      if (decoded.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        decoded.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : decoded.method === "tools/list"
            ? { tools: [] }
            : asRecord(decoded.params)?.name === "get_user"
              ? { content: [{ type: "text", text: JSON.stringify(viewer) }] }
              : asRecord(decoded.params)?.name === "get_workspace"
                ? { structuredContent: workspace, content: [] }
                : undefined;
      if (result === undefined) throw new Error("Unexpected fixture MCP method");
      return json({ jsonrpc: "2.0", id: decoded.id, result });
    }
    if (url === `${origin}/mcp` && init?.method === "DELETE")
      return new Response(null, { status: 405 });
    throw new Error("Unexpected fixture URL");
  };
  return {
    env,
    calls,
    fetchImpl,
    connection: new ManagedConnection({ env, fetchImpl }),
    refreshes: () => refreshes,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
function callback(start: { url?: unknown; redirectUri?: unknown }) {
  const target = fixtureCallbackUrl(start, "one-time-fixture-code");
  target.searchParams.set("iss", origin);
  return target.href;
}
async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const start = await f.connection.beginLogin({ actor: "user", scopes: ["read"] });
  return { start, status: await f.connection.finishLogin({ callbackUrl: callback(start) }) };
}

void test("default login uses public MCP registration and reports verified native limits without a product client", async () => {
  const f = await fixture();
  try {
    const { start, status } = await connect(f);
    assert.equal(new URL(start.url).origin, origin);
    assert.equal(new URL(start.url).searchParams.get("scope"), "read");
    assert.equal(new URL(start.url).searchParams.get("code_challenge_method"), "S256");
    const registration = fixtureRecord(f.calls.find((c) => c.url.endsWith("/register"))?.body);
    assert.equal(registration.token_endpoint_auth_method, "none");
    assert.equal(registration.scope, "read");
    assert.equal(registration.client_secret, undefined);
    const exchange = fixtureRecord(f.calls.find((c) => c.url.endsWith("/token"))?.body);
    assert.equal(exchange.client_id, "dynamic-public-fixture");
    assert.equal(exchange.client_secret, undefined);
    assert.ok(fixtureString(exchange.code_verifier).length >= 43);
    assert.deepEqual(status.identity, {
      ...viewer,
      workspace: { id: workspace.id, name: workspace.name, slug: "fixture" },
    });
    assert.deepEqual(status.capabilities, {
      mcp: true,
      native: false,
      storage: false,
      refresh: true,
      revoke: false,
    });
    assert.equal(
      (await new ManagedConnection({ env: f.env, fetchImpl: f.fetchImpl }).status(true)).epoch,
      status.epoch,
    );
    await assert.rejects(f.connection.authorization(), /LINEAR_AUTH_NATIVE_UNAVAILABLE/);
    await assert.rejects(
      f.connection.bearerToken(false, "https://other.example/mcp"),
      /LINEAR_AUTH_ENDPOINT_INVALID/,
    );
    const native = new LinearAppTokenProvider({
      env: f.env,
      connection: f.connection,
      fetchImpl: f.fetchImpl,
    });
    await assert.rejects(native.getAuthorization(), /LINEAR_AUTH_NATIVE_UNAVAILABLE/);
    await assert.rejects(native.getToken(), /LINEAR_AUTH_NATIVE_UNAVAILABLE/);
    const mcp = new LinearMcpClient({
      url: `${origin}/mcp`,
      connection: f.connection,
      token: "ambient-must-not-be-used",
      fetchImpl: f.fetchImpl,
    });
    try {
      await mcp.listTools();
    } finally {
      await mcp.close();
    }
    assert.equal(
      f.calls.some((c) => c.authorization?.includes("ambient-must-not-be-used")),
      false,
    );
    for (const secret of [
      "mcp-access-fixture",
      "mcp-refresh-fixture",
      "one-time-fixture-code",
      fixtureString(exchange.code_verifier),
    ])
      assert.equal(JSON.stringify(status).includes(secret), false);
    const beforeRevoke = f.calls.length;
    await assert.rejects(f.connection.revoke(), /LINEAR_AUTH_REVOKE_UNSUPPORTED/);
    assert.equal(f.calls.length, beforeRevoke);
  } finally {
    await f.cleanup();
  }
});

void test("default MCP browser login completes through the actual callback handler without product setup", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const f = await fixture({ redirectUri: `http://127.0.0.1:${port}/oauth/callback` });
  try {
    const events: string[] = [];
    const deliveries: Promise<Response>[] = [];
    const result = await managedAuthCommand(
      ["login", "--scope", "read", "--json", "--timeout", "1000"],
      {
        env: f.env,
        connection: f.connection,
        stdout: {
          write(value) {
            events.push(value);
            const event = jsonRecord(value);
            deliveries.push(fetch(callback(event)));
          },
        },
      },
    );
    assert.equal(jsonRecord(result).state, "connected");
    assert.equal(fixtureRecord(jsonRecord(result).capabilities).native, false);
    const delivered = deliveries.at(0);
    assert(delivered);
    assert.equal((await delivered).status, 200);
    assert.equal(new URL(fixtureString(jsonRecord(events[0]).url)).origin, origin);
    for (const secret of ["mcp-access-fixture", "mcp-refresh-fixture", "one-time-fixture-code"])
      assert.equal((result + events.join("")).includes(secret), false);
  } finally {
    await f.cleanup();
  }
});
void test("MCP refresh survives a process boundary, keeps its issuer and rotates once for concurrent readers", async () => {
  const f = await fixture({ expiry: 1 });
  try {
    const { status } = await connect(f);
    const a = new ManagedConnection({
      env: { ...f.env, LINEAR_AXI_AUTH_EPOCH: status.epoch },
      fetchImpl: f.fetchImpl,
    });
    const b = new ManagedConnection({ env: f.env, fetchImpl: f.fetchImpl });
    assert.deepEqual(await Promise.all([a.bearerToken(), b.bearerToken()]), [
      "mcp-refreshed-fixture",
      "mcp-refreshed-fixture",
    ]);
    assert.equal(f.refreshes(), 1);
    assert.equal((await a.epoch()).epoch, status.epoch);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/register")).length, 1);
    const refresh = f.calls.find((c) => c.body.grant_type === "refresh_token");
    assert(refresh);
    assert.equal(refresh.url, `${origin}/token`);
    assert.equal(refresh.body.resource, `${origin}/mcp`);
    await f.connection.logout();
    await assert.rejects(a.bearerToken(), /LINEAR_AUTH_CONTEXT_CHANGED/);
    await assert.rejects(b.bearerToken(), /LINEAR_AUTH_CONTEXT_CHANGED|LINEAR_AUTH_REQUIRED/);
  } finally {
    await f.cleanup();
  }
});

void test("an account change during MCP initialization prevents the following tool dispatch", async () => {
  const f = await fixture();
  const release = deferred();
  let client: LinearMcpClient | undefined;
  try {
    await connect(f);
    const entered = deferred();
    const before = f.calls.length;
    client = new LinearMcpClient({
      url: `${origin}/mcp`,
      connection: new ManagedConnection({ env: f.env, fetchImpl: f.fetchImpl }),
      fetchImpl: async (input, init) => {
        if (typeof init?.body === "string" && init.body.includes('"method":"initialize"')) {
          entered.resolve();
          await release.promise;
        }
        return f.fetchImpl(input, init);
      },
    });
    const calling = client.callTool("get_workspace", {});
    await entered.promise;
    await f.connection.logout();
    release.resolve();
    await assert.rejects(calling, /LINEAR_AUTH_CONTEXT_CHANGED/);
    assert.equal(
      f.calls.slice(before).some((call) => call.body.method === "tools/call"),
      false,
    );
  } finally {
    release.resolve();
    await client?.close();
    await f.cleanup();
  }
});
void test("a refreshed token with unknown expiry does not inherit the expired token's timestamp", async () => {
  const f = await fixture({ expiry: 1, omitRefreshExpiry: true });
  try {
    await connect(f);
    assert.equal(await f.connection.bearerToken(), "mcp-refreshed-fixture");
    const reopened = new ManagedConnection({ env: f.env, fetchImpl: f.fetchImpl });
    assert.equal(await reopened.bearerToken(), "mcp-refreshed-fixture");
    assert.equal(f.refreshes(), 1);
    assert.equal((await reopened.status()).state, "connected");
  } finally {
    await f.cleanup();
  }
});
void test("a default MCP callback is bound to both state and issuer and logout consumes it", async () => {
  const f = await fixture();
  try {
    const start = await f.connection.beginLogin({ actor: "user", scopes: ["read"] });
    const wrong = new URL(callback(start));
    wrong.searchParams.set("iss", "https://other.example");
    await assert.rejects(
      f.connection.finishLogin({ callbackUrl: wrong.href }),
      /LINEAR_AUTH_STATE_MISMATCH/,
    );
    wrong.searchParams.set("iss", origin);
    wrong.searchParams.set("state", "not-the-state");
    await assert.rejects(
      f.connection.finishLogin({ callbackUrl: wrong.href }),
      /LINEAR_AUTH_STATE_MISMATCH/,
    );
    await f.connection.logout();
    await assert.rejects(
      f.connection.finishLogin({ callbackUrl: callback(start) }),
      /LINEAR_AUTH_NO_PENDING_LOGIN/,
    );
    assert.equal(
      f.calls.some((c) => c.url.endsWith("/token")),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

void test("logout while dynamic registration is pending cannot revive a login callback", async () => {
  let reached!: () => void, release!: () => void;
  const announced = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    beforeRegister: async () => {
      reached();
      await resumed;
    },
  });
  try {
    const starting = f.connection.beginLogin({ actor: "user", scopes: ["read"] });
    await announced;
    const loggedOut = await new ManagedConnection({ env: f.env }).logout();
    release();
    await assert.rejects(starting, /LINEAR_AUTH_CONTEXT_CHANGED/);
    assert.deepEqual(await f.connection.epoch(), { epoch: loggedOut.epoch, state: "signed-out" });
    assert.equal(
      f.calls.some((c) => c.url.endsWith("/token")),
      false,
    );
  } finally {
    release();
    await f.cleanup();
  }
});
void test("a default OAuth grant cannot turn a read-only request into write access", async () => {
  const f = await fixture({ broaden: true });
  try {
    const start = await f.connection.beginLogin({ actor: "user", scopes: ["read"] });
    await assert.rejects(
      f.connection.finishLogin({ callbackUrl: callback(start) }),
      /LINEAR_AUTH_SCOPE_MISMATCH/,
    );
    assert.equal((await f.connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});

void test("MCP registration refuses a foreign authorization server before contacting it", async () => {
  const f = await fixture({ issuer: "https://other.example" });
  try {
    await assert.rejects(
      f.connection.beginLogin({ actor: "user", scopes: ["read"] }),
      /LINEAR_AUTH_MCP_LOGIN_FAILED/,
    );
    assert.equal(
      f.calls.some((c) => c.url.startsWith("https://other.example")),
      false,
    );
    assert.equal(
      f.calls.some((c) => c.url.endsWith("/register")),
      false,
    );
    assert.equal((await f.connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});

void test("status rechecks native capability without replacing a valid MCP connection", async () => {
  const options = { native: true };
  const f = await fixture(options);
  try {
    const initial = await connect(f);
    options.native = false;
    const checked = await f.connection.status(true);
    assert.equal(checked.epoch, initial.status.epoch);
    assert.equal(checked.capabilities.mcp, true);
    assert.equal(checked.capabilities.native, false);
    await assert.rejects(f.connection.authorization(), /LINEAR_AUTH_NATIVE_UNAVAILABLE/);
    assert.equal(
      f.calls.some((call) => call.authorization?.includes("ambient-must-not-be-used")),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
void test("native access for a default MCP grant is enabled only after verifying the same token", async () => {
  const f = await fixture({ native: true });
  try {
    const { status } = await connect(f);
    assert.equal(status.capabilities.native, true);
    assert.equal(status.capabilities.storage, false);
    const native = new LinearAppTokenProvider({
      env: f.env,
      connection: f.connection,
      fetchImpl: f.fetchImpl,
    });
    const before = f.calls.length;
    const storage = new LinearStorageClient({ tokenProvider: native, fetchImpl: f.fetchImpl });
    await assert.rejects(
      storage.download({
        workspace: "fixture",
        url: "https://uploads.linear.app/fixture/file.png",
        output: join(f.env.PI_CODING_AGENT_DIR, "not-written"),
      }),
      /LINEAR_AUTH_STORAGE_UNAVAILABLE/,
    );
    assert.equal(f.calls.length, before);
    assert.equal(await f.connection.authorization(), "Bearer mcp-access-fixture");
    assert.equal(status.capabilities.revoke, false);
  } finally {
    await f.cleanup();
  }
});
