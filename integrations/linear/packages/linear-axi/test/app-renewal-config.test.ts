import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinearAppTokenProvider } from "#axi/app-token.ts";

const scope = ["read", "write", "comments:create", "app:assignable", "webhook"];
const binding = { clientId: "fixture-client", scopes: scope };

void test("managed renewal prepares the pinned request without using a bearer override or network", async () => {
  const provider = new LinearAppTokenProvider({
    env: {
      LINEAR_AXI_CLIENT_ID: binding.clientId,
      LINEAR_AXI_CLIENT_SECRET: "synthetic-client-secret",
      LINEAR_AXI_TOKEN_SCOPE: [...scope].reverse().join(","),
      LINEAR_AXI_MCP_TOKEN: "synthetic-unrelated-bearer",
    },
    fetchImpl: async () => {
      throw new Error("Unexpected HTTP request");
    },
  });
  const request = await provider.renewalRequest(binding);
  assert.deepEqual(new Set(request.binding.scopes), new Set(scope));
  assert.deepEqual(Object.fromEntries(request.body), {
    grant_type: "client_credentials",
    client_id: binding.clientId,
    client_secret: "synthetic-client-secret",
    scope: request.binding.scopes.join(","),
  });
});

void test("managed renewal rejects missing or changed configuration rather than requesting default scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-app-renewal-config-"));
  try {
    const configured = {
      LINEAR_AXI_CLIENT_ID: binding.clientId,
      LINEAR_AXI_CLIENT_SECRET: "synthetic-client-secret",
      LINEAR_AXI_TOKEN_SCOPE: scope.join(","),
    };
    for (const change of [
      { LINEAR_AXI_CLIENT_ID: "another-client" },
      { LINEAR_AXI_CLIENT_SECRET: "" },
      { LINEAR_AXI_TOKEN_SCOPE: "read" },
      { LINEAR_AXI_TOKEN_SCOPE: "read,read" },
      { LINEAR_AXI_TOKEN_SCOPE: "read,unknown" },
      { LINEAR_AXI_TOKEN_SCOPE: undefined },
    ]) {
      const provider = new LinearAppTokenProvider({
        env: { ...configured, ...change },
        scopePath: join(directory, "missing.json"),
        fetchImpl: async () => {
          throw new Error("Unexpected HTTP request");
        },
      });
      await assert.rejects(
        () => provider.renewalRequest(binding),
        /^Error: LINEAR_AUTH_APP_RENEWAL_CONFIG$/,
      );
    }
    const scopePath = join(directory, "scope.json");
    await writeFile(scopePath, JSON.stringify({ scope: scope.join(",") }));
    const provider = new LinearAppTokenProvider({
      env: { ...configured, LINEAR_AXI_TOKEN_SCOPE: undefined },
      scopePath,
    });
    assert.deepEqual((await provider.renewalRequest(binding)).binding, binding);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
