/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ManagedConnection } from "#axi/managed-connection.ts";
import { NamedConnections } from "#axi/named-connections.ts";
import { LinearPreflightCache } from "#axi/preflight-cache.ts";

const windows = process.platform === "win32";
const viewer = {
  id: "user",
  name: "Fixture",
  organization: { id: "org", name: "Fixture", urlKey: "fixture" },
};

void test(
  "Windows credentials persist privately and reject access granted to everyone",
  { skip: !windows },
  async () => {
    const directory = await mkdtemp(join(homedir(), "linear-windows-auth-"));
    const file = join(directory, "connection.json");
    const connection = new ManagedConnection({
      env: { LINEAR_AXI_CONNECTION_FILE: file },
      fetchImpl: async () => new Response(JSON.stringify({ data: { viewer } })),
    });
    try {
      await connection.importCredential({ type: "api-key", token: "fixture-secret" });
      assert.equal((await connection.status()).state, "connected");
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"]);
      await assert.rejects(connection.status(), /LINEAR_AUTH_STORE_UNSAFE/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  "Windows refuses to write a credential in a directory accessible to everyone",
  { skip: !windows },
  async () => {
    const directory = await mkdtemp(join(homedir(), "linear-windows-unsafe-"));
    const file = join(directory, "connection.json");
    const connection = new ManagedConnection({ env: { LINEAR_AXI_CONNECTION_FILE: file } });
    try {
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(R)"]);
      await assert.rejects(connection.logout(), /LINEAR_AUTH_STORE_UNSAFE/);
      await assert.rejects(
        import("node:fs/promises").then(({ stat }) => stat(file)),
        { code: "ENOENT" },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
void test("Windows can reopen a named connection", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(homedir(), "linear-windows-named-"));
  const options = {
    env: { LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json") },
    fetchImpl: async () => new Response(JSON.stringify({ data: { viewer } })),
  };
  try {
    const connection = new NamedConnections(options);
    const saved = await connection.importCredential({
      type: "api-key",
      token: "fixture-secret",
      name: "Fixture",
    });
    const reopened = new NamedConnections(options);
    assert(saved.connectionId);
    await reopened.select(saved.connectionId);
    assert.equal((await reopened.status()).state, "connected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("Windows serializes concurrent preflight requests", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(homedir(), "linear-windows-contention-"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let checks = 0;
  const scope = { connectionId: "one", epoch: "one", server: "https://example.test" };
  const first = new LinearPreflightCache({
    directory,
    scope: async () => {
      if (++checks === 2) {
        entered();
        await gate;
      }
      return scope;
    },
  });
  const second = new LinearPreflightCache({ directory, scope: async () => scope });
  const fetchFixture: typeof fetch = async () => new Response("ok");
  try {
    const a = first.fetch("https://example.test", {}, fetchFixture);
    await locked;
    const b = second.fetch("https://example.test", {}, fetchFixture);
    const results = Promise.allSettled([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    release();
    for (const result of await results) {
      assert(result.status === "fulfilled", "The preflight request must succeed");
      assert.equal(result.value.status, 200);
    }
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});
void test("Windows private preflight cache persists metadata", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(homedir(), "linear-windows-cache-"));
  const cache = new LinearPreflightCache({
    directory: join(directory, "cache"),
    scope: async () => ({ connectionId: "one", epoch: "one", server: "https://example.test" }),
  });
  let loads = 0;
  const load = async () => ++loads;
  try {
    assert.equal(
      await cache.get("key", load, (value): value is number => typeof value === "number"),
      1,
    );
    assert.equal(
      await cache.get("key", load, (value): value is number => typeof value === "number"),
      1,
    );
    assert.equal(loads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
