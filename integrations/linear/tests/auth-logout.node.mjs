import { test } from "node:test";
import assert from "node:assert/strict";
import { logoutConnection } from "#linear/auth-logout.ts";

/** @typedef {import("#linear/auth-process.ts").AuthRunner} AuthRunner */
/** @typedef {import("#linear/auth-process.ts").AuthStatus} AuthStatus */
/** @typedef {import("#linear/auth-process.ts").AuthRunOptions} AuthRunOptions */
/** @typedef {[string, AuthRunOptions | undefined, readonly string[]]} RecordedCommand */

const id = "11111111-1111-4111-8111-111111111111";
/** @type {AuthStatus} */
const original = {
  state: "connected",
  epoch: "epoch-a",
  connectionId: id,
  credentialType: "oauth",
  capabilities: { mcp: false, native: true, storage: false, refresh: true, revoke: true },
};

/** @param {Partial<Record<string, (options: AuthRunOptions | undefined) => Promise<AuthStatus>>>} handlers */
function setup(handlers = {}) {
  /** @type {RecordedCommand[]} */
  const calls = [];
  /** @type {AuthRunner} */
  const run = async (_cwd, args, options) => {
    const [command] = args;
    assert(command);
    calls.push([command, options, args]);
    const respond = handlers[command];
    if (respond) return respond(options);
    return command === "epoch" ? original : { state: "signed-out", epoch: "done" };
  };
  return { calls, run };
}

void test("revokes the chosen OAuth connection using the confirmed epoch", async () => {
  const { calls, run } = setup();
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "removed");
  assert.equal(result.remote, "revoked");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke"],
  );
  const revoke = calls.at(1);
  assert(revoke?.[1]);
  assert.equal(revoke[1].connectionId, id);
  assert.equal(revoke[1].expectedEpoch, "epoch-a");
  assert.deepEqual(revoke[2], ["revoke", "--forget-on-refusal"]);
});

void test("attempts supported revocation for an expired OAuth grant", async () => {
  const { calls, run } = setup({ epoch: async () => ({ ...original, state: "expired" }) });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.remote, "revoked");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke"],
  );
});
void test("cancellation does not mutate a connection", async () => {
  const { calls, run } = setup();
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => false,
  });
  assert.equal(result.local, "cancelled");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch"],
  );
});

void test("unsupported credentials are locally removed with the original epoch", async () => {
  const { calls, run } = setup({
    epoch: async () => ({
      ...original,
      credentialType: "api-key",
      capabilities: { mcp: false, native: true, storage: false, refresh: false, revoke: false },
    }),
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "removed");
  assert.equal(result.remote, "unsupported");
  const logout = calls.at(1);
  assert(logout?.[1]);
  assert.equal(logout[0], "logout");
  assert.equal(logout[1].expectedEpoch, "epoch-a");
});

void test("a concurrent replacement is not removed after an uncertain revoke", async () => {
  let observations = 0;
  const { calls, run } = setup({
    epoch: async () => (++observations === 1 ? original : { ...original, epoch: "replacement" }),
    revoke: async () => {
      throw new Error("LINEAR_AUTH_REVOKE_UNKNOWN");
    },
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "changed");
  assert.equal(result.remote, "unknown");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke", "epoch"],
  );
});

void test("reports a refused remote revoke after the backend forgets the profile", async () => {
  let observations = 0;
  const { calls, run } = setup({
    epoch: async () => {
      if (++observations === 1) return original;
      throw new Error("LINEAR_AUTH_CONNECTION_REMOVED");
    },
    revoke: async () => {
      throw new Error("LINEAR_AUTH_REVOKE_REFUSED");
    },
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "removed");
  assert.equal(result.remote, "refused");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke", "epoch"],
  );
});
void test("a refused revoke does not delete a newer connected epoch", async () => {
  let observations = 0;
  const { calls, run } = setup({
    epoch: async () =>
      ++observations === 1 ? original : { ...original, epoch: "restored-or-replaced" },
    revoke: async () => {
      throw new Error("LINEAR_AUTH_REVOKE_REFUSED");
    },
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "changed");
  assert.equal(result.remote, "refused");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke", "epoch"],
  );
});

void test("local deletion preserves a concurrently replaced connection", async () => {
  const { run } = setup({
    epoch: async () => ({ ...original, credentialType: "api-key" }),
    logout: async () => {
      throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
    },
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "changed");
  assert.equal(result.remote, "unsupported");
});
void test("a retired connection is forgotten after an uncertain revoke without retrying revoke", async () => {
  let observations = 0;
  const { calls, run } = setup({
    epoch: async () =>
      ++observations === 1 ? original : { ...original, state: "signed-out", epoch: "retired" },
    revoke: async () => {
      throw new Error("LINEAR_AUTH_REVOKE_UNKNOWN");
    },
  });
  const result = await logoutConnection({
    cwd: "/tmp",
    connectionId: id,
    run,
    confirm: async () => true,
  });
  assert.equal(result.local, "removed");
  assert.equal(result.remote, "unknown");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["epoch", "revoke", "epoch", "logout"],
  );
  const logout = calls.at(3);
  assert(logout?.[1]);
  assert.equal(logout[1].expectedEpoch, "retired");
});
