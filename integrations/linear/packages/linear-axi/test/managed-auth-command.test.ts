/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LinearMcpClient } from "#axi/mcp.ts";
import { ManagedConnection } from "#axi/managed-connection.ts";
import { managedAuthCommand } from "#axi/commands/managed-auth.ts";
import { authCommand } from "#axi/commands/auth.ts";
import { LinearAppTokenProvider } from "#axi/app-token.ts";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { NativeWorkflowClient } from "#axi/native-workflow.ts";
import { LinearStorageClient } from "#axi/storage.ts";
import { fixtureCallbackUrl, fixtureRequestUrl, fixtureString } from "./fixtures/http.ts";
import { jsonRecord } from "./fixtures/json.ts";
import { fixtureGraphqlRequest } from "./fixtures/graphql-request.ts";

const runFile = promisify(execFile);

void test("plain auth commands use the selected connection and document private completion", async () => {
  const f = await fixture();
  try {
    await f.connection.importCredential({ type: "api-key", token: "fixture-plain-key" });
    const status = await authCommand(["status"], f.runtime);
    assert.match(status, /connected/);
    assert.match(status, /fixture-user/);
    assert.equal(status.includes("fixture-plain-key"), false);
    const help = await authCommand(["--help"], f.runtime);
    assert.match(help, /stdin/);
    assert.match(help, /PKCE/);
    assert.match(help, /revoke/);
    assert.doesNotMatch(help, /--code/);
    await authCommand(["logout"], f.runtime);
    assert.equal((await f.connection.status()).state, "signed-out");
    assert.equal(f.env.LINEAR_AXI_MCP_TOKEN, "ambient-fixture-token");
  } finally {
    await f.cleanup();
  }
});
void test("browser callback mode verifies the grant and emits only safe authorization/result events", async () => {
  const f = await fixture();
  try {
    const { createServer } = await import("node:http");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const connection = new ManagedConnection({
      env: { ...f.env, LINEAR_AXI_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/callback` },
      fetchImpl: async (url) =>
        fixtureRequestUrl(url).endsWith("/oauth/token")
          ? json({
              access_token: "fixture-browser-access",
              refresh_token: "fixture-browser-refresh",
              expires_in: 86400,
              scope: "read",
            })
          : json({ data: { viewer } }),
    });
    const events: string[] = [];
    const deliveries: Promise<Response>[] = [];
    const result = await managedAuthCommand(
      ["login", "--actor", "user", "--scope", "read", "--timeout", "1000", "--json"],
      {
        ...f.runtime,
        connection,
        stdout: {
          write(value: string) {
            events.push(value);
            deliveries.push(fetch(fixtureCallbackUrl(jsonRecord(value), "fixture-browser-code")));
          },
        },
      },
    );
    assert.equal(jsonRecord(result).event, "result");
    assert.equal(jsonRecord(result).state, "connected");
    const delivered = deliveries.at(0);
    assert(delivered);
    assert.equal((await delivered).status, 200);
    for (const secret of [
      "fixture-browser-access",
      "fixture-browser-refresh",
      "fixture-browser-code",
    ])
      assert.equal((events.join("") + result).includes(secret), false);
  } finally {
    await f.cleanup();
  }
});

void test("callback timeout consumes pending login without claiming authorization", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      managedAuthCommand(["login", "--timeout", "100", "--json"], f.runtime),
      /LINEAR_AUTH_CALLBACK_TIMEOUT/,
    );
    assert.equal((await f.connection.status()).state, "signed-out");
    await assert.rejects(
      f.connection.finishLogin({
        callbackUrl: "http://127.0.0.1:14566/oauth/callback?code=late&state=late",
      }),
      /LINEAR_AUTH_NO_PENDING_LOGIN/,
    );
  } finally {
    await f.cleanup();
  }
});
void test("the actual CLI emits safe JSON errors and a logout tombstone overrides inherited credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-managed-cli-"));
  const bin = fileURLToPath(import.meta.resolve("#axi/bin.ts"));
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    PI_CODING_AGENT_DIR: directory,
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_MCP_TOKEN: "ambient-cli-fixture",
  };
  try {
    const initial = await runFile(process.execPath, [bin, "auth", "epoch", "--json"], { env });
    assert.equal(jsonRecord(initial.stdout).state, "legacy");
    const logout = await runFile(process.execPath, [bin, "auth", "logout", "--json"], { env });
    assert.equal(jsonRecord(logout.stdout).state, "signed-out");
    const status = await runFile(process.execPath, [bin, "auth", "status", "--json"], { env });
    assert.equal(jsonRecord(status.stdout).state, "signed-out");
    await assert.rejects(
      runFile(
        process.execPath,
        [bin, "auth", "import", "--json", "--token", "secret-argument-fixture"],
        { env },
      ),
      (error) => {
        const failure = error as Error & { stdout: string; stderr: string; code: number };
        assert.equal(failure.code, 1);
        assert.equal(jsonRecord(failure.stdout).error, "LINEAR_AUTH_INPUT_INVALID");
        assert.equal(failure.stdout.includes("secret-argument-fixture"), false);
        assert.equal(failure.stderr.includes("secret-argument-fixture"), false);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("MCP selects the managed credential and refuses a logged-out session before transport", async () => {
  const f = await fixture();
  try {
    await f.connection.importCredential({ type: "api-key", token: "managed-mcp-key-fixture" });
    const sent: string[] = [];
    const client = new LinearMcpClient({
      url: "https://mcp.linear.app/mcp",
      token: "ambient-fixture",
      connection: new ManagedConnection({ env: f.env }),
      fetchImpl: async (_url, init) => {
        sent.push(fixtureString(new Headers(init?.headers).get("authorization")));
        throw new Error("fixture transport offline");
      },
    });
    await assert.rejects(client.connect());
    assert.ok(sent.length > 0);
    assert.ok(sent.every((value) => value === "Bearer managed-mcp-key-fixture"));
    await client.close();
    await f.connection.logout();
    const disconnected = new LinearMcpClient({
      url: "https://mcp.linear.app/mcp",
      token: "ambient-fixture",
      connection: new ManagedConnection({ env: f.env }),
      fetchImpl: async () => {
        throw new Error("transport must not run");
      },
    });
    await assert.rejects(disconnected.listTools(), /LINEAR_AUTH_REQUIRED/);
  } finally {
    await f.cleanup();
  }
});

const viewer = {
  id: "fixture-user",
  name: "Fixture",
  organization: { id: "fixture-org", name: "Fixture workspace", urlKey: "fixture" },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "linear-managed-command-"));
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    LINEAR_AXI_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/callback`,
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "fixture-public-client",
    LINEAR_AXI_MCP_TOKEN: "ambient-fixture-token",
  };
  const connection = new ManagedConnection({
    env,
    fetchImpl: async (url) =>
      fixtureRequestUrl(url).includes("/oauth/token")
        ? json({
            access_token: "fixture-private-access",
            refresh_token: "fixture-private-refresh",
            expires_in: 86400,
            scope: "read",
          })
        : json({ data: { viewer } }),
  });
  const runtime = { env, connection, stdin: Readable.from([]), stdout: { write() {} } };
  return {
    directory,
    env,
    connection,
    runtime,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("status rechecks the selected identity instead of claiming a revoked token is authorized", async () => {
  const f = await fixture();
  let valid = true;
  try {
    const connection = new ManagedConnection({
      env: f.env,
      fetchImpl: async () =>
        valid
          ? json({ data: { viewer } })
          : json({ errors: [{ message: "untrusted secret fixture" }] }, 401),
    });
    await connection.importCredential({ type: "oauth", token: "fixture-access" });
    valid = false;
    await assert.rejects(
      managedAuthCommand(["status", "--json"], { ...f.runtime, connection }),
      /^Error: LINEAR_AUTH_INVALID_CREDENTIAL$/,
    );
  } finally {
    await f.cleanup();
  }
});
void test("JSON auth uses private stdin and local logout blocks ambient native credentials", async () => {
  const f = await fixture();
  try {
    const result = jsonRecord(
      await managedAuthCommand(["import", "--json"], {
        ...f.runtime,
        stdin: Readable.from([JSON.stringify({ type: "api-key", token: "fixture-private-key" })]),
      }),
    );
    assert.equal(result.state, "connected");
    assert.equal(JSON.stringify(result).includes("fixture-private-key"), false);
    const epoch = jsonRecord(await managedAuthCommand(["epoch", "--json"], f.runtime));
    assert.equal(epoch.epoch, result.epoch);
    await assert.rejects(
      managedAuthCommand(["import", "--json", "--token", "fixture-private-key"], f.runtime),
      /^Error: LINEAR_AUTH_INPUT_INVALID$/,
    );
    assert.equal(
      jsonRecord(await managedAuthCommand(["logout", "--json"], f.runtime)).state,
      "signed-out",
    );
    const provider = new LinearAppTokenProvider({
      env: f.env,
      connection: new ManagedConnection({ env: f.env }),
      fetchImpl: async () => {
        throw new Error("ambient exchange must not run");
      },
    });
    await assert.rejects(provider.getAuthorization(), /LINEAR_AUTH_REQUIRED/);
  } finally {
    await f.cleanup();
  }
});

void test("manual PKCE completion accepts a callback only through stdin and returns no credential material", async () => {
  const f = await fixture();
  try {
    const pending = jsonRecord(
      await managedAuthCommand(["login", "--actor", "app", "--manual", "--json"], f.runtime),
    );
    assert.equal(pending.event, "authorization");
    assert.equal(pending.pending, true);
    const authUrl = new URL(fixtureString(pending.url));
    assert.equal(authUrl.searchParams.get("actor"), "app");
    const callbackUrl = `${fixtureString(pending.redirectUri)}?code=fixture-private-code&state=${authUrl.searchParams.get("state")}`;
    const result = await managedAuthCommand(["finish", "--json"], {
      ...f.runtime,
      stdin: Readable.from([JSON.stringify({ callbackUrl })]),
    });
    assert.equal(jsonRecord(result).state, "connected");
    for (const sensitive of [
      "fixture-private-code",
      "fixture-private-access",
      "fixture-private-refresh",
    ])
      assert.equal(result.includes(sensitive), false);
  } finally {
    await f.cleanup();
  }
});

void test("managed key headers reach native transports and a native mutation is not replayed after 401", async () => {
  const f = await fixture();
  try {
    await f.connection.importCredential({ type: "api-key", token: "fixture-native-key" });
    const provider = new LinearAppTokenProvider({ env: f.env, connection: f.connection });
    const headers: string[] = [];
    const requests: { query: string; redirect?: RequestRedirect }[] = [];
    const teamId = "11111111-1111-4111-8111-111111111111";
    const organization = { id: "22222222-2222-4222-8222-222222222222", urlKey: "fixture" };
    const fetchImpl: typeof fetch = async (_url, init) => {
      headers.push(fixtureString(new Headers(init?.headers).get("authorization")));
      const { query } = fixtureGraphqlRequest(init);
      requests.push({ query, redirect: init?.redirect });
      return query.startsWith("query WorkflowTeam")
        ? json({ data: { viewer: { organization }, team: { id: teamId, organization } } })
        : json({}, 401);
    };
    const graphql = new LinearGraphqlClient({ tokenProvider: provider, fetchImpl });
    const mutation = await graphql.invokeWorkflow(
      "save_workflow_skill",
      { teamId, title: "Fixture", body: "Fixture body" },
      "fixture",
    );
    assert.equal(mutation.error, "LINEAR_GRAPHQL_AUTH_REQUIRED");
    assert.equal(mutation.effect, "unknown");
    const mutations = requests.filter(({ query }) => query.startsWith("mutation"));
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].redirect, "error");
    assert.deepEqual(headers, ["fixture-native-key", "fixture-native-key"]);
    const native = new NativeWorkflowClient({ tokenProvider: provider, fetchImpl });
    const receipt = await native.invoke("get_workflow_template", { id: teamId }, "fixture");
    assert.equal(receipt.error, "LINEAR_GRAPHQL_AUTH_REQUIRED");
    assert.deepEqual(headers, ["fixture-native-key", "fixture-native-key", "fixture-native-key"]);
    await f.connection.logout();
    const storage = new LinearStorageClient({ tokenProvider: provider, fetchImpl });
    await assert.rejects(
      storage.download({
        workspace: "fixture",
        url: "https://uploads.linear.app/fixture",
        output: join(f.directory, "download"),
      }),
      /LINEAR_GRAPHQL_AUTH_REQUIRED/,
    );
    assert.equal(headers.length, 3);
  } finally {
    await f.cleanup();
  }
});

void test("a granted scope broader than requested is refused rather than stored as read-only", async () => {
  const f = await fixture();
  try {
    const connection = new ManagedConnection({
      env: f.env,
      fetchImpl: async () =>
        json({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          expires_in: 86400,
          scope: "read write",
        }),
    });
    const start = await connection.beginLogin({ actor: "user", scopes: ["read"] });
    await assert.rejects(
      connection.finishLogin({
        callbackUrl: `${start.redirectUri}?code=fixture-code&state=${new URL(start.url).searchParams.get("state")}`,
      }),
      /LINEAR_AUTH_SCOPE_MISMATCH/,
    );
    assert.equal((await connection.status()).state, "signed-out");
  } finally {
    await f.cleanup();
  }
});
