import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReaOwner } from "./owner.mjs";

const evidence = {
  evidence_id: `ev_${"a".repeat(64)}`,
  operation: "analyze_function",
  authority: "shipped-artifact",
  subject: { digest: { sha256: createHash("sha256").update("owned fixture").digest("hex") } },
  provider: { id: "ghidra" },
  limitations: ["Static observation; runtime reachability is not proven."],
  normalized_result: {
    procedure: { name: "rank" },
    pseudocode: "int rank() { return 7; }\n",
    callers: [],
    callees: [],
  },
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rea-owner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "target");
  await writeFile(binary, "owned fixture");
  const calls = [];
  let disconnected = false;
  const owner = new ReaOwner({ binary, application: root }, async () => ({
    async call(name, args, signal) {
      signal?.throwIfAborted();
      calls.push({ name, args });
      if (overrides.call) return overrides.call(name, args, signal);
      return name === "analyze_function" ? evidence : { result: { open: name === "open_binary" } };
    },
    async close() {
      disconnected = true;
    },
  }));
  return { owner, binary, calls, disconnected: () => disconnected };
}

test("retained text is session-owned and does not re-run the provider", async (t) => {
  const { owner, calls, disconnected } = await fixture(t);
  const first = await owner.resolve("rea://native/rank");
  assert.match(first.source, /^rea:\/\/[a-f0-9-]+\/ev_[a-f0-9]{64}\/pseudocode$/);
  assert.match(await owner.read(first.source), /return 7/);
  assert.match(first.text, /Static observation/);
  assert.equal((await owner.resolve("rea://native/rank")).source, first.source);
  assert.equal(calls.filter((call) => call.name === "analyze_function").length, 1);
  await owner.close();
  assert.equal(disconnected(), true);
  await assert.rejects(owner.read(first.source), /closed|expired/);
  await assert.rejects(owner.resolve("rea://native/rank"), /closed|expired/);
});

test("changed input cannot reuse retained authority even when its bytes are restored", async (t) => {
  const { owner, binary } = await fixture(t);
  const first = await owner.resolve("rea://native/rank");
  await writeFile(binary, "changed");
  await assert.rejects(owner.read(first.source), /changed/);
  await writeFile(binary, "owned fixture");
  await assert.rejects(owner.read(first.source), /changed/);
  await owner.close();
});

test("an Evidence URI cannot be rebound after changing and restoring its artifact", async (t) => {
  const { owner, binary } = await fixture(t);
  const first = await owner.resolve("rea://native/rank");
  await writeFile(binary, "changed");
  await writeFile(binary, "owned fixture");
  await assert.rejects(owner.resolve("rea://native/another_alias"), /different immutable snapshot/);
  await assert.rejects(owner.read(first.source), /closed|expired/);
});
test("a native dossier from another artifact cannot become a selectable snapshot", async (t) => {
  const { owner, disconnected } = await fixture(t, {
    call: async (name) =>
      name === "analyze_function"
        ? { ...evidence, subject: { digest: { sha256: "b".repeat(64) } } }
        : {},
  });
  await assert.rejects(owner.resolve("rea://native/rank"), /artifact digest mismatch/);
  assert.equal(disconnected(), true);
});
test("cleanup failure is visible but still disconnects and invalidates references", async (t) => {
  const { owner, disconnected } = await fixture(t, {
    call: async (name) => {
      if (name === "close_binary") throw new Error("cleanup_incomplete: unowned process");
      return name === "analyze_function" ? evidence : {};
    },
  });
  const first = await owner.resolve("rea://native/rank");
  await assert.rejects(owner.close(), /cleanup_incomplete/);
  assert.equal(disconnected(), true);
  await assert.rejects(owner.read(first.source), /closed|expired/);
});

test("closing during analysis cancels the request without deadlocking the serial owner", async (t) => {
  let started;
  const active = new Promise((resolve) => {
    started = resolve;
  });
  const { owner, disconnected } = await fixture(t, {
    call: async (name, _args, signal) => {
      if (name !== "analyze_function") return {};
      started();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const pending = owner.resolve("rea://native/rank");
  await active;
  const closing = owner.close();
  await assert.rejects(pending, /closed/);
  await closing;
  assert.equal(disconnected(), true);
});
test("an aborted request cannot publish a snapshot and the private connection closes", async (t) => {
  const controller = new AbortController();
  const { owner, disconnected } = await fixture(t, {
    call: async (name, _args, signal) => {
      if (name === "analyze_function") {
        controller.abort(new Error("cancel owned analysis"));
        signal.throwIfAborted();
      }
      return {};
    },
  });
  await assert.rejects(
    owner.resolve("rea://native/rank", controller.signal),
    /cancel owned analysis/,
  );
  assert.equal(disconnected(), true);
  await assert.rejects(owner.resolve("rea://native/rank"), /closed|expired/);
});
