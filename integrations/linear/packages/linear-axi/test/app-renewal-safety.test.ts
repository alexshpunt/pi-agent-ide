import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedConnection } from "#axi/managed-connection.ts";

void test("an uncertain app renewal is fenced across instances and cannot be revoked as a known grant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "linear-renewal-safety-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_TOKEN_FILE: join(directory, "cache.json"),
    LINEAR_AXI_CLIENT_ID: "client",
    LINEAR_AXI_CLIENT_SECRET: "secret",
    LINEAR_AXI_TOKEN_SCOPE: "read",
    LINEAR_AXI_TOKEN_URL: "http://127.0.0.1:9999/token",
  };
  await writeFile(
    env.LINEAR_AXI_TOKEN_FILE,
    JSON.stringify({ accessToken: "old", expiresAt: Date.now() + 3600000 }),
  );
  let exchanges = 0;
  let fencedAtDispatch = false;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).includes("/token")) {
      exchanges++;
      const persisted = JSON.parse(await readFile(env.LINEAR_AXI_CONNECTION_FILE, "utf8"));
      fencedAtDispatch = persisted.appRenewalPending === true;
      throw new Error("lost response");
    }
    return Response.json({
      data: {
        viewer: {
          id: "app",
          name: "App",
          app: true,
          organization: { id: "org", name: "Org", urlKey: "org" },
        },
      },
    });
  };
  const connection = new ManagedConnection({ env, fetchImpl });
  await connection.connectInstalledApp();
  await connection.enableAppRenewal(["read"]);
  const changed = new ManagedConnection({
    env: { ...env, LINEAR_AXI_TOKEN_URL: "http://127.0.0.1:9998/token" },
    fetchImpl,
  });
  await assert.rejects(changed.authorization(true));
  assert.equal(exchanges, 0);
  await assert.rejects(connection.authorization(true));
  assert.equal(exchanges, 1);
  assert.equal(fencedAtDispatch, true);
  const stored = JSON.parse(await readFile(env.LINEAR_AXI_CONNECTION_FILE, "utf8"));
  assert.equal(stored.appRenewalPending, true);
  const reopened = new ManagedConnection({ env, fetchImpl });
  await assert.rejects(reopened.authorization());
  await assert.rejects(reopened.authorization(true));
  await assert.rejects(reopened.enableAppRenewal(["read"]));
  await assert.rejects(reopened.revoke());
  assert.equal(exchanges, 1);
  await reopened.logout();
  assert.equal((await reopened.status()).state, "signed-out");
});
