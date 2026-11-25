import test from "node:test";
import assert from "node:assert/strict";
import { LinearMcpClient, LinearOAuthProvider } from "#axi/mcp.ts";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LinearPreflightCache } from "#axi/preflight-cache.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonRecord } from "./fixtures/json.ts";

void test("remote client uses OAuth provider when no bearer token is configured", () => {
  const client = new LinearMcpClient({ url: "https://mcp.linear.app/mcp" });

  assert.ok(client.authProvider instanceof LinearOAuthProvider);
});

void test("remote client keeps bearer token path for token endpoints", () => {
  const client = new LinearMcpClient({ url: "https://example.test/mcp", token: "secret" });

  assert.equal(client.authProvider, null);
});

void test("OAuth provider persists state for Linear CSRF validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-oauth-"));
  const storePath = join(dir, "oauth.json");
  const provider = new LinearOAuthProvider({ storePath });

  const first = await provider.state();
  const second = await provider.state();
  const store = jsonRecord(await readFile(storePath, "utf8"));

  assert.equal(first, second);
  assert.equal(store.state, first);

  await provider.invalidateCredentials("verifier");
  const resetStore = jsonRecord(await readFile(storePath, "utf8"));
  assert.equal(resetStore.state, undefined);
});

void test("OAuth provider deletes the local credential store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-oauth-"));
  const storePath = join(dir, "oauth.json");
  const provider = new LinearOAuthProvider({ storePath });

  await provider.saveTokens({ access_token: "initial", token_type: "Bearer" });

  assert.equal(await provider.deleteStore(), true);
  await assert.rejects(() => stat(storePath), /ENOENT/);
  assert.equal(await provider.deleteStore(), false);
});

void test("OAuth provider tightens permissions on existing token store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-axi-oauth-"));
  const storePath = join(dir, "oauth.json");
  const provider = new LinearOAuthProvider({ storePath });

  await provider.saveTokens({ access_token: "initial", token_type: "Bearer" });
  await chmod(storePath, 0o666);
  await provider.saveTokens({ access_token: "updated", token_type: "Bearer" });

  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
});

void test("tool error payloads bypass success-only schemas without weakening successful output validation", async (t) => {
  const client = new LinearMcpClient({ url: "https://example.test/mcp" });
  const valid = { structuredContent: { id: "saved" }, content: [] };
  let result: {
    structuredContent?: Record<string, unknown>;
    content: never[];
    isError?: boolean;
  } = valid;
  const sdk = new Client({ name: "linear-test", version: "1" });
  const server = new Server(
    { name: "linear-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  t.after(async () => {
    await sdk.close();
    await server.close();
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "save_comment",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => result);
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  await sdk.connect(transport);
  client.client = sdk;
  await client.listTools();
  assert.deepEqual(await client.callTool("save_comment", {}), valid);
  result = { structuredContent: { id: 5 }, content: [] };
  await assert.rejects(client.callTool("save_comment", {}), { code: -32602 });
  result = { content: [] };
  await assert.rejects(client.callTool("save_comment", {}), { code: -32600 });
  result = { isError: true, structuredContent: { error: "invalid_request" }, content: [] };
  assert.deepEqual(await client.callTool("save_comment", {}), result);
});

void test("cached output schemas are compiled before a mutation can be dispatched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "linear-cached-output-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const cache = new LinearPreflightCache({
    directory,
    scope: async () => ({
      connectionId: "11111111-1111-4111-8111-111111111111",
      epoch: "one",
      server: "https://example.test/mcp",
    }),
  });
  const tools = [
    {
      name: "save_comment",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { id: { $ref: "urn:missing-fixture-schema" } } },
    },
  ];
  await cache.get(
    "tools",
    async () => tools,
    (value): value is typeof tools => Array.isArray(value),
  );
  let mutations = 0;
  const client = new LinearMcpClient({ url: "https://example.test/mcp", preflightCache: cache });
  const sdk = new Client({ name: "linear-test", version: "1" });
  sdk.request = async () => {
    mutations++;
    throw new Error("A mutation reached the client without validated schemas");
  };
  client.client = sdk;
  await assert.rejects(async () => {
    await client.listTools();
    await client.callTool("save_comment", {});
  });
  assert.equal(mutations, 0);
});
