import test from "node:test";
import assert from "node:assert/strict";
import { fixtureRequestUrl, fixtureFormBody, fixtureString } from "./fixtures/http.ts";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagedConnection } from "#axi/managed-connection.ts";

const viewer = {
  id: "user-a",
  name: "Fixture A",
  email: "a@example.test",
  organization: { id: "org-a", name: "Fixture", urlKey: "fixture" },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

void test("cancelling a code exchange releases its process lock and cannot authorize a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-managed-cancel-"));
  const env = {
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "fixture-public-client",
  };
  const moduleUrl = import.meta.resolve("#axi/managed-connection.ts");
  const script = `import { ManagedConnection } from ${JSON.stringify(moduleUrl)};
const connection = new ManagedConnection({ env: ${JSON.stringify(env)}, fetchImpl: async () => { process.stdout.write("exchange-started\\n"); return new Promise(() => {}); } });
const keepAlive = setInterval(() => {}, 1000);
const start = await connection.beginLogin({ actor: "user", scopes: ["read"] });
await connection.finishLogin({ callbackUrl: start.redirectUri + "?code=fixture&state=" + new URL(start.url).searchParams.get("state") });
clearInterval(keepAlive);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("fixture child never reached exchange")),
        5000,
      );
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("exchange-started")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("fixture child exited early"));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await assert.rejects(stat(env.LINEAR_AXI_CONNECTION_FILE + ".lock"), /ENOENT/);
    const reopened = new ManagedConnection({ env });
    assert.equal((await reopened.status()).state, "signed-out");
    assert.equal((await reopened.logout()).state, "signed-out");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(fetchImpl: typeof fetch = async () => response({ data: { viewer } })) {
  const directory = await mkdtemp(join(tmpdir(), "linear-managed-auth-"));
  const env = {
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "public-fixture-client",
    LINEAR_AXI_MCP_TOKEN: "old-ambient-fixture",
  };
  return {
    directory,
    env,
    connection: new ManagedConnection({ env, fetchImpl }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("local logout blocks every ambient credential and imported keys keep their native header type", async () => {
  const headers: string[] = [];
  const f = await fixture(async (_url, init) => {
    headers.push(fixtureString(new Headers(init?.headers).get("authorization")));
    return response({ data: { viewer } });
  });
  try {
    assert.deepEqual(await f.connection.epoch(), { epoch: "legacy", state: "legacy" });
    assert.equal(await f.connection.authorization(), undefined);
    const signedIn = await f.connection.importCredential({
      type: "api-key",
      token: "fixture-private-key",
    });
    assert.equal(signedIn.state, "connected");
    assert.equal(signedIn.identity?.workspace.slug, "fixture");
    assert.equal(await f.connection.authorization(), "fixture-private-key");
    assert.equal(headers[0], "fixture-private-key");
    assert.equal(JSON.stringify(signedIn).includes("fixture-private-key"), false);
    assert.equal((await stat(f.env.LINEAR_AXI_CONNECTION_FILE)).mode & 0o777, 0o600);
    await f.connection.logout();
    const reopened = new ManagedConnection({ env: f.env });
    assert.equal((await reopened.status()).state, "signed-out");
    await assert.rejects(reopened.authorization(), /LINEAR_AUTH_REQUIRED/);
  } finally {
    await f.cleanup();
  }
});

void test("identity checks distinguish transport failures from rejected credentials without exposing private details", async () => {
  for (const [failure, expected] of [
    [new DOMException("private request details", "TimeoutError"), "LINEAR_AUTH_IDENTITY_TIMEOUT"],
    [
      new TypeError("private request details", {
        cause: Object.assign(new Error("private network details"), { code: "ENOTFOUND" }),
      }),
      "LINEAR_AUTH_IDENTITY_CONNECTION_FAILED",
    ],
    [new Error("private unknown details"), "LINEAR_AUTH_IDENTITY_UNAVAILABLE"],
  ] as const) {
    const f = await fixture(async () => {
      throw failure;
    });
    try {
      await assert.rejects(
        f.connection.importCredential({ type: "api-key", token: "fixture-private-key" }),
        new RegExp("^Error: " + expected + "$"),
      );
      assert.equal((await f.connection.status()).state, "signed-out");
    } finally {
      await f.cleanup();
    }
  }
});
void test("a misconfigured identity endpoint is not reported as a rejected API key or network failure", async () => {
  const f = await fixture(async () => {
    throw new Error("network should not be contacted");
  });
  try {
    const connection = new ManagedConnection({
      env: { ...f.env, LINEAR_AXI_GRAPHQL_URL: "https://untrusted.example/graphql" },
    });
    await assert.rejects(
      connection.importCredential({ type: "api-key", token: "fixture-private-key" }),
      /^Error: LINEAR_AUTH_ENDPOINT_INVALID$/,
    );
  } finally {
    await f.cleanup();
  }
});
void test("an invalid imported credential cannot authorize a session or leak the remote response", async () => {
  const f = await fixture(async () =>
    response({ errors: [{ message: "echo fixture-secret" }] }, 401),
  );
  try {
    await assert.rejects(
      f.connection.importCredential({ type: "oauth", token: "fixture-secret" }),
      /^Error: LINEAR_AUTH_INVALID_CREDENTIAL$/,
    );
    assert.equal((await f.connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});

void test("an operation pinned to account A cannot acquire account B's credential", async () => {
  const f = await fixture();
  try {
    const a = await f.connection.importCredential({ type: "oauth", token: "fixture-a" });
    const pinned = new ManagedConnection({ env: { ...f.env, LINEAR_AXI_AUTH_EPOCH: a.epoch } });
    assert.equal(await pinned.authorization(), "Bearer fixture-a");
    await f.connection.logout();
    await f.connection.importCredential({ type: "oauth", token: "fixture-b" });
    await assert.rejects(pinned.authorization(), /LINEAR_AUTH_CONTEXT_CHANGED/);
  } finally {
    await f.cleanup();
  }
});

void test("PKCE exchange uses a public client and logout consumes a pending callback", async () => {
  const requests: URLSearchParams[] = [];
  const f = await fixture(async (url, init) => {
    if (fixtureRequestUrl(url).endsWith("/oauth/token")) {
      requests.push(fixtureFormBody(init));
      return response({
        access_token: "fixture-oauth-access",
        refresh_token: "fixture-refresh",
        expires_in: 86400,
        scope: "read",
      });
    }
    return response({ data: { viewer } });
  });
  try {
    const start = await f.connection.beginLogin({ actor: "user", scopes: ["read"] });
    const url = new URL(start.url);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_id"), "public-fixture-client");
    assert.equal(url.searchParams.get("client_secret"), null);
    const callback = new URL(start.redirectUri);
    callback.searchParams.set("state", fixtureString(url.searchParams.get("state")));
    callback.searchParams.set("code", "fixture-code");
    const status = await f.connection.finishLogin({ callbackUrl: callback.href });
    assert.equal(status.state, "connected");
    assert.equal(status.actor, "user");
    assert.equal(requests[0].get("grant_type"), "authorization_code");
    assert.ok(requests[0].get("code_verifier"));
    assert.equal(requests[0].has("client_secret"), false);
    await f.connection.logout();
    await assert.rejects(
      f.connection.finishLogin({ callbackUrl: callback.href }),
      /LINEAR_AUTH_NO_PENDING_LOGIN/,
    );
  } finally {
    await f.cleanup();
  }
});

void test("state mismatch never exchanges an authorization code", async () => {
  let exchanges = 0;
  const f = await fixture(async () => {
    exchanges++;
    return response({});
  });
  try {
    const start = await f.connection.beginLogin({ actor: "app", scopes: ["read"] });
    await assert.rejects(
      f.connection.finishLogin({
        callbackUrl: `${start.redirectUri}?code=fixture-code&state=wrong`,
      }),
      /LINEAR_AUTH_STATE_MISMATCH/,
    );
    assert.equal(exchanges, 0);
    assert.equal((await f.connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});

void test("concurrent consumers share refresh rotation and never change the identity epoch", async () => {
  let refreshes = 0;
  const f = await fixture(async (url, init) => {
    if (fixtureRequestUrl(url).endsWith("/oauth/token")) {
      const body = fixtureFormBody(init);
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return response({
          access_token: "fixture-fresh-access",
          refresh_token: "fixture-fresh-refresh",
          expires_in: 86400,
          scope: "read",
        });
      }
      return response({
        access_token: "fixture-expiring-access",
        refresh_token: "fixture-initial-refresh",
        expires_in: 0,
        scope: "read",
      });
    }
    return response({ data: { viewer } });
  });
  try {
    const start = await f.connection.beginLogin({ actor: "user", scopes: ["read"] });
    const callback = `${start.redirectUri}?code=fixture-code&state=${new URL(start.url).searchParams.get("state")}`;
    const connected = await f.connection.finishLogin({ callbackUrl: callback });
    // Separate instances use the same file lock; injected transport is shared only by this fixture.
    const options = {
      env: f.env,
      fetchImpl: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(fixtureFormBody(init).get("grant_type"), "refresh_token");
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return response({
          access_token: "fixture-fresh-access",
          refresh_token: "fixture-fresh-refresh",
          expires_in: 86400,
          scope: "read",
        });
      },
    };
    const tokens = await Promise.all([
      new ManagedConnection(options).authorization(),
      new ManagedConnection(options).authorization(),
    ]);
    assert.deepEqual(tokens, ["Bearer fixture-fresh-access", "Bearer fixture-fresh-access"]);
    assert.equal(refreshes, 1);
    assert.equal((await f.connection.epoch()).epoch, connected.epoch);
  } finally {
    await f.cleanup();
  }
});

void test("symlinked connection files are refused without modifying their targets", async () => {
  const f = await fixture();
  try {
    const target = join(f.directory, "target");
    await symlink(target, f.env.LINEAR_AXI_CONNECTION_FILE);
    await assert.rejects(f.connection.logout(), /LINEAR_AUTH_STORE_UNSAFE/);
    await assert.rejects(stat(target), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});

void test("unknown revoke delivery clears only the selected local session and is not replayed", async () => {
  let revokes = 0;
  const f = await fixture(async (url) => {
    if (fixtureRequestUrl(url).endsWith("/oauth/revoke")) {
      revokes++;
      throw new Error("fixture remote connection lost");
    }
    return response({ data: { viewer } });
  });
  try {
    await f.connection.importCredential({ type: "oauth", token: "fixture-access" });
    await assert.rejects(f.connection.revoke(), /LINEAR_AUTH_REVOKE_UNKNOWN/);
    assert.equal((await f.connection.status()).state, "signed-out");
    await assert.rejects(f.connection.revoke(), /LINEAR_AUTH_REVOKE_UNSUPPORTED/);
    assert.equal(revokes, 1);
  } finally {
    await f.cleanup();
  }
});
