import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUnknownArray } from "#axi/types.ts";
import { fixtureString } from "./fixtures/http.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";

const cli = fileURLToPath(import.meta.resolve("#axi/bin.ts"));
const scope = ["read", "write", "comments:create", "app:assignable", "webhook"];
const oldToken = "synthetic-installed-app-token";
const newToken = "synthetic-renewed-app-token";
const clientSecret = "synthetic-app-client-secret";
const app = {
  id: "fixture-app",
  name: "Fixture installed app",
  app: true,
  organization: {
    id: "70000000-0000-4000-8000-000000000001",
    name: "Fixture workspace",
    urlKey: "example",
  },
};
interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  value: Record<string, unknown>;
}
async function execute(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: unknown,
): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--import", new URL("./fixtures/app-renewal-network.mjs", import.meta.url).href, cli, ...args],
    {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let value: Record<string, unknown> = {};
  try {
    value = jsonRecord(stdout.trim());
  } catch {
    // Non-auth commands use TOON; assertions inspect those outputs directly.
  }
  return { code, stdout, stderr, value };
}
function succeeds(result: CliResult): Record<string, unknown> {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result.value;
}
function privateOutput(result: CliResult) {
  for (const secret of [oldToken, newToken, clientSecret]) {
    assert.equal((result.stdout + result.stderr).includes(secret), false);
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "linear-app-renewal-"));
  const connectionFile = join(directory, "connection.json");
  const cacheFile = join(directory, "app-token.json");
  const calls: Array<{ url: string; authorization?: string; body: string }> = [];
  let tokenReply: unknown = {
    access_token: newToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: scope.join(" "),
  };
  let tokenStatus = 200;
  let viewer: unknown = app;
  let redirect = false;
  let mutations = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += fixtureString(chunk);
      calls.push({
        url: fixtureString(request.url),
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/oauth/token") {
        if (redirect) {
          response.writeHead(302, { location: "/must-not-follow" });
          response.end();
        } else {
          response.writeHead(tokenStatus).end(JSON.stringify(tokenReply));
        }
      } else if (request.url === "/graphql") {
        const query = fixtureString(jsonRecord(body).query);
        if (/\bmutation\b/u.test(query)) {
          mutations++;
          response.writeHead(401).end(JSON.stringify({ errors: [{ message: newToken }] }));
        } else {
          response.end(JSON.stringify({ data: { viewer } }));
        }
      } else {
        response.writeHead(500).end(JSON.stringify({ error: "unexpected fixture request" }));
      }
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("Invalid fixture request"));
    });
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      PI_CODING_AGENT_DIR: join(directory, "agent"),
      CODEX_CONFIG: join(directory, "absent-codex.toml"),
      LINEAR_AXI_CONNECTION_FILE: connectionFile,
      LINEAR_TEST_HTTP_ORIGIN: address,
      LINEAR_AXI_TOKEN_FILE: cacheFile,
      LINEAR_AXI_CLIENT_ID: "synthetic-app-client",
      LINEAR_AXI_CLIENT_SECRET: clientSecret,
      LINEAR_AXI_TOKEN_SCOPE: scope.join(","),
      LINEAR_AXI_TOKEN_URL: address + "/oauth/token",
      LINEAR_AXI_GRAPHQL_URL: address + "/graphql",
      LINEAR_AXI_MCP_URL: address + "/mcp",
    };
    const cache = JSON.stringify({ accessToken: oldToken, expiresAt: Date.now() + 3600_000 });
    await writeFile(cacheFile, cache, { mode: 0o600 });
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      execute(directory, { ...env, ...overrides }, args);
    const connected = succeeds(
      await run(["auth", "connect-app", "--name", "Installed fixture", "--json"]),
    );
    const connectionId = fixtureString(connected.connectionId);
    env.LINEAR_AXI_CONNECTION_ID = connectionId;
    succeeds(await run(["auth", "default", "--id", connectionId, "--json"]));
    const grantFile = join(connectionFile + ".connections", `${connectionId}.json`);
    const catalogFile = connectionFile + ".profiles.json";
    const enable = (overrides: NodeJS.ProcessEnv = {}, declared = scope.join(",")) =>
      run(["auth", "enable-app-renewal", "--scope", declared, "--json"], overrides);
    const expire = async (remainingMs = -1000) => {
      const store = jsonRecord(await readFile(grantFile, "utf8"));
      fixtureRecord(store.credential).expiresAt = Date.now() + remainingMs;
      await writeFile(grantFile, JSON.stringify(store), { mode: 0o600 });
    };
    return {
      directory,
      env,
      run,
      enable,
      expire,
      calls,
      connected,
      cache,
      cacheFile,
      grantFile,
      catalogFile,
      setReply(value: unknown, status = 200) {
        tokenReply = value;
        tokenStatus = status;
      },
      setViewer(value: unknown) {
        viewer = value;
      },
      setRedirect() {
        redirect = true;
      },
      get mutations() {
        return mutations;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

void test("the CLI fixture transport refuses external destinations before dispatch", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./fixtures/app-renewal-network.mjs", import.meta.url).href,
      "--input-type=module",
      "--eval",
      'try { await fetch("https://api.linear.app/oauth/token"); process.exitCode = 1; } catch (error) { if (error.code !== "LINEAR_TEST_HTTP_OUTSIDE_FIXTURE") process.exitCode = 2; }',
    ],
    {
      env: { PATH: process.env.PATH, LINEAR_TEST_HTTP_ORIGIN: "http://127.0.0.1:1" },
      stdio: "ignore",
    },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
});
void test("an existing installed app opts into renewal locally without replacing its connection or token", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const catalog = await readFile(f.catalogFile, "utf8");
  const prior = jsonRecord(await readFile(f.grantFile, "utf8"));
  f.calls.length = 0;
  const enabled = await f.enable();
  const status = succeeds(enabled);
  privateOutput(enabled);
  assert.equal(status.connectionId, f.connected.connectionId);
  assert.equal(status.defaultConnectionId, f.connected.connectionId);
  assert.equal(status.epoch, f.connected.epoch);
  assert.equal(status.actor, "app");
  assert.equal(fixtureRecord(status.capabilities).refresh, true);
  assert.deepEqual(status.scopes, [], "A local declaration is not a server scope verification");
  assert.equal(await readFile(f.catalogFile, "utf8"), catalog);
  assert.equal(await readFile(f.cacheFile, "utf8"), f.cache);
  const bound = jsonRecord(await readFile(f.grantFile, "utf8"));
  assert.equal(
    fixtureRecord(bound.credential).accessToken,
    fixtureRecord(prior.credential).accessToken,
  );
  assert.equal(
    fixtureRecord(bound.credential).expiresAt,
    fixtureRecord(prior.credential).expiresAt,
  );
  assert.equal(JSON.stringify(bound).includes(clientSecret), false);
  succeeds(await f.enable());
  assert.equal(f.calls.length, 0);
});

void test("independent CLI processes share one app replacement and preserve the identity epoch", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  succeeds(await f.enable());
  await f.expire();
  const expired = succeeds(await f.run(["auth", "epoch", "--json"]));
  assert.equal(expired.state, "expired");
  assert.equal(fixtureRecord(expired.capabilities).refresh, true);
  const catalog = await readFile(f.catalogFile, "utf8");
  f.calls.length = 0;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => f.run(["auth", "status", "--json"])),
  );
  for (const result of results) {
    const status = succeeds(result);
    privateOutput(result);
    assert.equal(status.state, "connected");
    assert.equal(status.epoch, f.connected.epoch);
    assert.equal(status.connectionId, f.connected.connectionId);
    assert.equal(fixtureRecord(status.identity).id, app.id);
    assert.equal(fixtureRecord(fixtureRecord(status.identity).workspace).id, app.organization.id);
    assert.equal(status.actor, "app");
    assert.deepEqual(status.scopes, scope);
  }
  const exchanges = f.calls.filter((call) => call.url === "/oauth/token");
  assert.equal(exchanges.length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchanges[0].body)), {
    grant_type: "client_credentials",
    client_id: "synthetic-app-client",
    client_secret: clientSecret,
    scope: scope.join(","),
  });
  assert.equal(
    f.calls
      .filter((call) => call.url === "/graphql")
      .every((call) => call.authorization === `Bearer ${newToken}`),
    true,
  );
  assert.equal(await readFile(f.catalogFile, "utf8"), catalog);
  assert.equal(await readFile(f.cacheFile, "utf8"), f.cache);
  assert.equal(
    fixtureRecord(jsonRecord(await readFile(f.grantFile, "utf8")).credential).accessToken,
    newToken,
  );
  succeeds(await f.enable());
  assert.equal(f.calls.filter((call) => call.url === "/oauth/token").length, 1);
});

void test("a still-valid App renews before expiry and retains requested scopes when the reply omits scope", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  succeeds(await f.enable());
  await f.expire(20_000);
  assert.equal(succeeds(await f.run(["auth", "epoch", "--json"])).state, "connected");
  f.setReply({ access_token: newToken, token_type: "Bearer", expires_in: 3600 });
  f.calls.length = 0;
  const renewed = succeeds(await f.run(["auth", "status", "--json"]));
  assert.deepEqual(renewed.scopes, scope);
  assert.equal(renewed.epoch, f.connected.epoch);
  assert.equal(f.calls.filter((call) => call.url === "/oauth/token").length, 1);
  assert.equal(
    f.calls
      .filter((call) => call.url === "/graphql")
      .every((call) => call.authorization === `Bearer ${newToken}`),
    true,
  );
});
void test("an expired associated cache can be bound without making an authenticated request", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.expire();
  await writeFile(f.cacheFile, JSON.stringify({ accessToken: oldToken, expiresAt: 0 }));
  f.calls.length = 0;
  const status = succeeds(await f.enable());
  assert.equal(status.state, "expired");
  assert.equal(fixtureRecord(status.capabilities).refresh, true);
  assert.equal(status.connectionId, f.connected.connectionId);
  assert.equal(f.calls.length, 0);
});

void test("renewal cannot be enabled on a personal key or an imported token with an unknown actor", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const type of ["api-key", "oauth"]) {
    const imported = succeeds(
      await execute(f.directory, f.env, ["auth", "import", "--json"], {
        type,
        token: "synthetic-other-credential",
        name: type,
      }),
    );
    f.calls.length = 0;
    const result = await f.enable({
      LINEAR_AXI_CONNECTION_ID: fixtureString(imported.connectionId),
    });
    assert.equal(result.code, 1);
    assert.equal(result.value.error, "LINEAR_AUTH_APP_REQUIRED");
    assert.equal(f.calls.length, 0);
  }
});
void test("unbound expired installed apps do not exchange a token implicitly", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.expire();
  const before = await readFile(f.grantFile, "utf8");
  f.calls.length = 0;
  const result = await f.run(["auth", "status", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(result.value.error, "LINEAR_AUTH_EXPIRED");
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.grantFile, "utf8"), before);
  privateOutput(result);
});

void test("binding requires an explicit unchanged declaration and an associated installed token", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.calls.length = 0;
  const before = await readFile(f.grantFile, "utf8");
  for (const result of [
    await f.run(["auth", "enable-app-renewal", "--json"]),
    await f.enable({}, "read"),
    await f.enable({ LINEAR_AXI_CLIENT_SECRET: undefined }),
    await f.enable({ LINEAR_AXI_CLIENT_ID: undefined }),
    await f.enable({ LINEAR_AXI_TOKEN_SCOPE: undefined }),
    await f.enable({ LINEAR_AXI_TOKEN_SCOPE: "read,read" }),
    await f.enable({ LINEAR_AXI_TOKEN_SCOPE: "read,unknown" }),
  ]) {
    assert.equal(result.code, 1);
    assert.equal(result.value.error, "LINEAR_AUTH_APP_RENEWAL_CONFIG");
    privateOutput(result);
  }
  await writeFile(
    f.cacheFile,
    JSON.stringify({ accessToken: "different-cache-token", expiresAt: Date.now() + 3600_000 }),
  );
  const mismatch = await f.enable();
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.value.error, "LINEAR_AUTH_APP_TOKEN_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.grantFile, "utf8"), before);
});

void test("changed or missing app configuration refuses before renewal and never uses ambient bearer credentials", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  succeeds(await f.enable());
  await f.expire();
  const before = await readFile(f.grantFile, "utf8");
  f.calls.length = 0;
  for (const overrides of [
    { LINEAR_AXI_CLIENT_ID: "different-client" },
    { LINEAR_AXI_CLIENT_SECRET: undefined },
    { LINEAR_AXI_TOKEN_SCOPE: "read" },
    { LINEAR_AXI_TOKEN_SCOPE: "read,read" },
    { LINEAR_AXI_TOKEN_SCOPE: "read,unknown" },
    { LINEAR_AXI_TOKEN_SCOPE: undefined },
  ]) {
    const result = await f.run(["auth", "status", "--json"], {
      ...overrides,
      LINEAR_AXI_MCP_TOKEN: "ambient-must-not-be-used",
      LINEAR_MCP_TOKEN: "other-ambient-must-not-be-used",
    });
    assert.equal(result.code, 1);
    assert.equal(result.value.error, "LINEAR_AUTH_APP_RENEWAL_CONFIG");
    privateOutput(result);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.grantFile, "utf8"), before);
});

void test("scope order and an explicit scope file preserve the pinned scope set", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const scopeFile = join(f.directory, "app-scope.json");
  await writeFile(scopeFile, JSON.stringify({ scope: scope.join(",") }));
  succeeds(
    await f.enable(
      { LINEAR_AXI_TOKEN_SCOPE: undefined, LINEAR_AXI_APP_SCOPE_FILE: scopeFile },
      [...scope].reverse().join(","),
    ),
  );
  await f.expire();
  f.setReply({
    access_token: newToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: [...scope].reverse().join(" "),
  });
  const renewed = succeeds(
    await f.run(["auth", "status", "--json"], {
      LINEAR_AXI_TOKEN_SCOPE: [...scope].reverse().join(","),
    }),
  );
  assert(isUnknownArray(renewed.scopes));
  assert.deepEqual(new Set(renewed.scopes), new Set(scope));
  const exchange = f.calls.find((call) => call.url === "/oauth/token");
  assert(exchange);
  assert.deepEqual(
    new Set(fixtureString(new URLSearchParams(exchange.body).get("scope")).split(",")),
    new Set(scope),
  );
});

for (const [label, viewer] of [
  ["a human actor", { ...app, app: false }],
  ["another app actor", { ...app, id: "different-app" }],
  ["another workspace", { ...app, organization: { ...app.organization, id: "different-org" } }],
] as const) {
  void test(`a replacement identifying ${label} never changes the persisted grant`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    succeeds(await f.enable());
    await f.expire();
    const before = await readFile(f.grantFile, "utf8");
    f.setViewer(viewer);
    const result = await f.run(["auth", "status", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.value.error, "LINEAR_AUTH_IDENTITY_MISMATCH");
    assert.equal(await readFile(f.grantFile, "utf8"), before);
    privateOutput(result);
  });
}

for (const [label, patch, expected] of [
  ["reduced scopes", { scope: "read" }, "LINEAR_AUTH_INVALID_SCOPE"],
  ["expanded scopes", { scope: scope.join(" ") + " issues:create" }, "LINEAR_AUTH_INVALID_SCOPE"],
  ["duplicate scopes", { scope: scope.join(" ") + " read" }, "LINEAR_AUTH_INVALID_SCOPE"],
  ["an empty token", { access_token: "" }, "LINEAR_AUTH_INVALID_CREDENTIAL"],
  ["a wrong token type", { token_type: "MAC" }, "LINEAR_AUTH_INVALID_RESPONSE"],
  ["missing expiry", { expires_in: undefined }, "LINEAR_AUTH_INVALID_RESPONSE"],
  ["zero expiry", { expires_in: 0 }, "LINEAR_AUTH_INVALID_RESPONSE"],
  ["an already near-expiry token", { expires_in: 30 }, "LINEAR_AUTH_INVALID_RESPONSE"],
  ["a string expiry", { expires_in: "3600" }, "LINEAR_AUTH_INVALID_RESPONSE"],
] as const) {
  void test(`a renewal response with ${label} never publishes a replacement`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    succeeds(await f.enable());
    await f.expire();
    const before = await readFile(f.grantFile, "utf8");
    f.calls.length = 0;
    f.setReply({
      access_token: newToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: scope.join(" "),
      ...patch,
    });
    const result = await f.run(["auth", "status", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.value.error, expected);
    assert.equal(await readFile(f.grantFile, "utf8"), before);
    assert.deepEqual(
      f.calls.map((call) => call.url),
      ["/oauth/token"],
    );
    privateOutput(result);
  });
}

void test("a rejected or redirected exchange does not leak its response or follow the redirect", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  succeeds(await f.enable());
  await f.expire();
  const before = await readFile(f.grantFile, "utf8");
  f.calls.length = 0;
  f.setReply({ error: "invalid_client", error_description: clientSecret }, 401);
  const denied = await f.run(["auth", "status", "--json"]);
  assert.equal(denied.code, 1);
  privateOutput(denied);
  f.setRedirect();
  const redirected = await f.run(["auth", "status", "--json"]);
  assert.equal(redirected.code, 1);
  privateOutput(redirected);
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ["/oauth/token", "/oauth/token"],
  );
  assert.equal(await readFile(f.grantFile, "utf8"), before);
});

void test("a failed native mutation is dispatched once after proactive renewal, never replayed", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  succeeds(await f.enable());
  await f.expire();
  const input = join(f.directory, "mutation.json");
  await writeFile(
    input,
    JSON.stringify({ query: 'mutation Fixture { issueArchive(id: "fixture-issue") { success } }' }),
  );
  f.calls.length = 0;
  const result = await f.run(["api", "graphql", "--workspace", "example", "--input-file", input]);
  const receipt = fixtureRecord(succeeds(result).graphql);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 401);
  assert.equal(receipt.effect, "not-applied");
  assert.equal(f.mutations, 1);
  assert.equal(f.calls.filter((call) => call.url === "/oauth/token").length, 1);
  privateOutput(result);
});
