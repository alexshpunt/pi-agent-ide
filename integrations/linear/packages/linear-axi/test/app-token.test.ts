import test from "node:test";
import assert from "node:assert/strict";
import { fixtureFormBody, fixtureString } from "./fixtures/http.ts";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LinearAppTokenProvider } from "#axi/app-token.ts";

void test("app token provider exchanges client credentials and reuses a mode-600 cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-token-"));
  const cachePath = join(dir, "app-token.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
      status: 200,
    });
  };
  const options = {
    env: { LINEAR_AXI_CLIENT_ID: "client", LINEAR_AXI_CLIENT_SECRET: "secret" },
    cachePath,
    fetchImpl,
    scopePath: join(dir, "app-scope.json"),
  };

  const first = await new LinearAppTokenProvider(options).getToken();
  const second = await new LinearAppTokenProvider(options).getToken();

  assert.equal(first, "token-1");
  assert.equal(second, "token-1");
  assert.equal(calls, 1);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
});

void test("operator scope config is used only when environment does not override it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-scope-"));
  try {
    const scopePath = join(dir, "app-scope.json");
    await writeFile(scopePath, JSON.stringify({ scope: "read,write,comments:create" }));
    const scopes: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      scopes.push(fixtureString(fixtureFormBody(init).get("scope")));
      return new Response(JSON.stringify({ access_token: "fixture-token", expires_in: 3600 }));
    };
    const options = {
      scopePath,
      cachePath: join(dir, "token.json"),
      fetchImpl,
      env: { LINEAR_AXI_CLIENT_ID: "fixture-client", LINEAR_AXI_CLIENT_SECRET: "fixture-secret" },
    };
    await new LinearAppTokenProvider(options).getToken(true);
    await new LinearAppTokenProvider({
      ...options,
      env: { ...options.env, LINEAR_AXI_TOKEN_SCOPE: "read" },
    }).getToken(true);
    assert.deepEqual(scopes, ["read,write,comments:create", "read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("assignable App scope is exchanged exactly and retained through cache reuse and renewal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-assignable-"));
  try {
    const scopePath = join(dir, "app-scope.json");
    const scope = "read,write,comments:create,app:assignable";
    await writeFile(scopePath, JSON.stringify({ scope }));
    const scopes: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = new URLSearchParams(init?.body as string);
      assert.equal(body.get("grant_type"), "client_credentials");
      scopes.push(fixtureString(body.get("scope")));
      return new Response(
        JSON.stringify({ access_token: "fixture-token-" + scopes.length, expires_in: 3600 }),
      );
    };
    const options = {
      scopePath,
      cachePath: join(dir, "token.json"),
      fetchImpl,
      env: { LINEAR_AXI_CLIENT_ID: "fixture-client", LINEAR_AXI_CLIENT_SECRET: "fixture-secret" },
    };
    assert.equal(await new LinearAppTokenProvider(options).getToken(), "fixture-token-1");
    assert.equal(await new LinearAppTokenProvider(options).getToken(), "fixture-token-1");
    assert.deepEqual(scopes, [scope]);
    assert.equal(await new LinearAppTokenProvider(options).getToken(true), "fixture-token-2");
    await writeFile(
      options.cachePath,
      JSON.stringify({ accessToken: "expired-fixture-token", expiresAt: 0 }),
    );
    assert.equal(await new LinearAppTokenProvider(options).getToken(), "fixture-token-3");
    assert.deepEqual(scopes, [scope, scope, scope]);
    assert.equal((await stat(options.cachePath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("webhook App scope is exchanged unchanged without broadening validation or bypassing cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-webhook-"));
  try {
    const scopePath = join(dir, "app-scope.json");
    const scope = "read,write,comments:create,app:assignable,webhook";
    await writeFile(scopePath, JSON.stringify({ scope }));
    const scopes: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = new URLSearchParams(init?.body as string);
      assert.equal(body.get("grant_type"), "client_credentials");
      scopes.push(fixtureString(body.get("scope")));
      return new Response(
        JSON.stringify({ access_token: "fixture-token-" + scopes.length, expires_in: 3600 }),
      );
    };
    const options = {
      scopePath,
      cachePath: join(dir, "token.json"),
      fetchImpl,
      env: { LINEAR_AXI_CLIENT_ID: "fixture-client", LINEAR_AXI_CLIENT_SECRET: "fixture-secret" },
    };
    assert.equal(await new LinearAppTokenProvider(options).getToken(), "fixture-token-1");
    assert.equal(await new LinearAppTokenProvider(options).getToken(), "fixture-token-1");
    assert.deepEqual(scopes, [scope]);
    assert.equal(await new LinearAppTokenProvider(options).getToken(true), "fixture-token-2");
    assert.deepEqual(scopes, [scope, scope]);
    await new LinearAppTokenProvider({
      ...options,
      env: { ...options.env, LINEAR_AXI_TOKEN_SCOPE: "read" },
    }).getToken(true);
    assert.deepEqual(scopes, [scope, scope, "read"]);
    for (const invalid of [
      `${scope},admin`,
      `${scope},app:unknown`,
      `${scope},webhook`,
      "read,write,comments:create,app:assignable, webhook",
    ]) {
      await writeFile(scopePath, JSON.stringify({ scope: invalid }));
      await assert.rejects(
        new LinearAppTokenProvider(options).getToken(true),
        /LINEAR_INVALID_APP_SCOPE_CONFIG/,
      );
    }
    assert.equal(scopes.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
void test("assignability does not permit admin, unknown App scopes or malformed scope combinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-assignable-"));
  try {
    const scopePath = join(dir, "app-scope.json");
    let calls = 0;
    const provider = new LinearAppTokenProvider({
      scopePath,
      cachePath: join(dir, "token.json"),
      env: { LINEAR_AXI_CLIENT_ID: "fixture-client", LINEAR_AXI_CLIENT_SECRET: "fixture-secret" },
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: "fixture-token", expires_in: 3600 }));
      },
    });
    for (const scope of [
      "read,write,comments:create,app:assignable,admin",
      "read,write,comments:create,app:assignable,app:unknown",
      "read,write,app:assignable,app:assignable",
      "read,write, app:assignable",
      "read,write,app:assignable,",
    ]) {
      await writeFile(scopePath, JSON.stringify({ scope }));
      await assert.rejects(provider.getToken(true), /LINEAR_INVALID_APP_SCOPE_CONFIG/);
    }
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
void test("missing scope config preserves defaults and malformed config cannot trigger a token exchange", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-scope-"));
  try {
    const scopePath = join(dir, "app-scope.json");
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      assert.equal(new URLSearchParams(init?.body as string).get("scope"), "read,comments:create");
      return new Response(JSON.stringify({ access_token: "fixture-token", expires_in: 3600 }));
    };
    const options = {
      scopePath,
      cachePath: join(dir, "token.json"),
      fetchImpl,
      env: { LINEAR_AXI_CLIENT_ID: "fixture-client", LINEAR_AXI_CLIENT_SECRET: "fixture-secret" },
    };
    await new LinearAppTokenProvider(options).getToken(true);
    for (const value of [
      { scope: "admin" },
      { scope: "read,write,write" },
      { scope: "read,unknown" },
      { scope: 1 },
    ]) {
      await writeFile(scopePath, JSON.stringify(value));
      await assert.rejects(
        new LinearAppTokenProvider(options).getToken(true),
        /LINEAR_INVALID_APP_SCOPE_CONFIG/,
      );
    }
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
void test("configured bearer token takes precedence over client credentials", async () => {
  let calls = 0;
  const provider = new LinearAppTokenProvider({
    env: { LINEAR_AXI_MCP_TOKEN: "configured" },
    fetchImpl: async () => {
      calls += 1;
      return new Response("", { status: 500 });
    },
  });

  assert.equal(await provider.getToken(), "configured");
  assert.equal(calls, 0);
});
