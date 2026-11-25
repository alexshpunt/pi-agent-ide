import test from "node:test";
import assert from "node:assert/strict";
import { fixtureRequestUrl, fixtureFormBody } from "./fixtures/http.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { ManagedConnection } from "#axi/managed-connection.ts";
import { managedAuthCommand } from "#axi/commands/managed-auth.ts";

async function fixture(revokeStatus = 200) {
  const directory = await mkdtemp(join(tmpdir(), "linear-revoke-safety-"));
  const env = {
    PI_CODING_AGENT_DIR: directory,
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "isolated-public-client",
  };
  const revoked: string[] = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    if (fixtureRequestUrl(url).endsWith("/oauth/revoke")) {
      revoked.push(fixtureFormBody(options).get("token") ?? "");
      return new Response("", { status: revokeStatus });
    }
    const authorization = new Headers(options?.headers).get("authorization");
    const id = authorization === "Bearer fixture-oauth-b" ? "b" : "a";
    return Response.json({
      data: {
        viewer: {
          id,
          name: `Fixture ${id}`,
          organization: { id: "workspace", name: "Example", urlKey: "example" },
        },
      },
    });
  };
  const connection = new ManagedConnection({ env, fetchImpl });
  return {
    env,
    connection,
    fetchImpl,
    revoked,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("a revocation confirmed for account A cannot revoke replacement account B", async () => {
  const f = await fixture();
  try {
    const selected = await f.connection.importCredential({
      type: "oauth",
      token: "fixture-oauth-a",
    });
    await f.connection.logout();
    await f.connection.importCredential({ type: "oauth", token: "fixture-oauth-b" });
    const stale = new ManagedConnection({
      env: { ...f.env, LINEAR_AXI_AUTH_EPOCH: selected.epoch },
      fetchImpl: f.fetchImpl,
    });
    await assert.rejects(stale.revoke(), /LINEAR_AUTH_CONTEXT_CHANGED/);
    assert.deepEqual(f.revoked, []);
    assert.equal((await f.connection.status()).identity?.id, "b");
  } finally {
    await f.cleanup();
  }
});

void test("a server error during revocation is unknown and retires only the selected local grant", async () => {
  const f = await fixture(500);
  try {
    await f.connection.importCredential({ type: "oauth", token: "fixture-oauth-a" });
    await assert.rejects(f.connection.revoke(), /LINEAR_AUTH_REVOKE_UNKNOWN/);
    assert.deepEqual(f.revoked, ["fixture-oauth-a"]);
    assert.equal((await f.connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});

void test("revocation retires A before dispatch and restores it only after a definite refusal", async () => {
  const f = await fixture(400);
  let during: Awaited<ReturnType<ManagedConnection["status"]>> | undefined;
  const connection = new ManagedConnection({
    env: f.env,
    fetchImpl: async (url, options) => {
      if (fixtureRequestUrl(url).endsWith("/oauth/revoke")) during = await f.connection.status();
      return f.fetchImpl(url, options);
    },
  });
  try {
    const before = await f.connection.importCredential({ type: "oauth", token: "fixture-oauth-a" });
    await assert.rejects(connection.revoke(), /LINEAR_AUTH_REVOKE_REFUSED/);
    assert.equal(during?.state, "signed-out");
    const after = await f.connection.status();
    assert.equal(after.state, "connected");
    assert.equal(after.identity?.id, "a");
    assert.notEqual(after.epoch, before.epoch);
  } finally {
    await f.cleanup();
  }
});

void test("a refused revoke cannot restore A over a connection selected during dispatch", async () => {
  const f = await fixture(400);
  const connection = new ManagedConnection({
    env: f.env,
    fetchImpl: async (url, options) => {
      if (fixtureRequestUrl(url).endsWith("/oauth/revoke"))
        await f.connection.importCredential({ type: "oauth", token: "fixture-oauth-b" });
      return f.fetchImpl(url, options);
    },
  });
  try {
    await f.connection.importCredential({ type: "oauth", token: "fixture-oauth-a" });
    await assert.rejects(connection.revoke(), /LINEAR_AUTH_REVOKE_REFUSED/);
    assert.equal((await f.connection.status()).identity?.id, "b");
    assert.deepEqual(f.revoked, ["fixture-oauth-a"]);
  } finally {
    await f.cleanup();
  }
});

void test("callback timeout settles even when a local client leaves an incomplete HTTP request open", async () => {
  const f = await fixture();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const connection = new ManagedConnection({
    env: { ...f.env, LINEAR_AXI_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/callback` },
    fetchImpl: f.fetchImpl,
  });
  let announced!: () => void;
  const ready = new Promise<void>((resolve) => {
    announced = resolve;
  });
  const signing = managedAuthCommand(["login", "--timeout", "100", "--json"], {
    env: f.env,
    connection,
    stdout: { write: () => announced() },
  }).then(
    () => "authorized",
    () => "failed",
  );
  let socket: Socket | undefined;
  try {
    await ready;
    const connected = connect(port, "127.0.0.1");
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      connected.once("connect", resolve);
      connected.once("error", reject);
    });
    socket.write("GET /oauth/callback HTTP/1.1\r\nHost: localhost\r\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      signing,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    assert.equal(outcome, "failed");
  } finally {
    socket?.destroy();
    await signing;
    await f.cleanup();
  }
});
