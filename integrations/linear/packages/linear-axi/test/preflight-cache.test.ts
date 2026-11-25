/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { deferred } from "./fixtures/http.ts";
import { mkdtemp, rm, readdir, symlink, writeFile, chmod, utimes, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinearPreflightCache, type PreflightScope } from "#axi/preflight-cache.ts";

const scope: PreflightScope = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  epoch: "epoch-a",
  server: "https://example.test/mcp",
};
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = { ...scope };
  let now = 100_000;
  const options = { directory, scope: async () => current, now: () => now, ttlMs: 1000 };
  return {
    directory,
    cache: () => new LinearPreflightCache(options),
    setScope: (next: PreflightScope) => {
      current = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test("independent cache instances reuse verified metadata within its validity window", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const load = async () => {
    calls++;
    return ["get_project"];
  };
  assert.deepEqual(await f.cache().get("tools", load, strings), ["get_project"]);
  assert.deepEqual(await f.cache().get("tools", load, strings), ["get_project"]);
  assert.equal(calls, 1);
});

for (const rollbackMs of [2000, 2001]) {
  void test(`metadata clock-skew tolerance ends after 2000ms (${rollbackMs}ms rollback)`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const load = async () => [String(++calls)];
    assert.deepEqual(await f.cache().get("tools", load, strings), ["1"]);
    f.advance(-rollbackMs);
    const expectedLoads = rollbackMs <= 2000 ? 1 : 2;
    assert.deepEqual(await f.cache().get("tools", load, strings), [String(expectedLoads)]);
    assert.equal(calls, expectedLoads);
    f.advance(rollbackMs + 1000);
    assert.deepEqual(await f.cache().get("tools", load, strings), [String(expectedLoads + 1)]);
  });
}

void test("concurrent cold callers share one metadata load", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return ["get_project"];
  };
  const values = await Promise.all(
    Array.from({ length: 4 }, () => f.cache().get("tools", load, strings)),
  );
  assert(values.every((value) => value[0] === "get_project"));
  assert.equal(calls, 1);
});

void test("expired metadata is fetched again instead of kept indefinitely", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const load = async () => [String(++calls)];
  assert.deepEqual(await f.cache().get("tools", load, strings), ["1"]);
  f.advance(1001);
  assert.deepEqual(await f.cache().get("tools", load, strings), ["2"]);
});

void test("connection, epoch and server changes cannot share preflight proof", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const load = async () => [String(++calls)];
  await f.cache().get("workspace:example", load, strings);
  for (const next of [
    { ...scope, epoch: "epoch-b" },
    { ...scope, connectionId: "22222222-2222-4222-8222-222222222222" },
    { ...scope, server: "https://other.test/mcp" },
  ]) {
    f.setScope(next);
    await f.cache().get("workspace:example", load, strings);
  }
  assert.equal(calls, 4);
});

void test("failed loads and principal changes during a load are never cached as proof", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.cache().get(
      "tools",
      async () => {
        throw Error("unavailable");
      },
      strings,
    ),
    /unavailable/,
  );
  await assert.rejects(
    f.cache().get(
      "tools",
      async () => {
        f.setScope({ ...scope, epoch: "epoch-b" });
        return ["get_project"];
      },
      strings,
    ),
    /LINEAR_AUTH_CONTEXT_CHANGED/,
  );
});

void test("safe corrupted metadata is a miss while unsafe files fail closed", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const load = async () => [String(++calls)];
  await f.cache().get("tools", load, strings);
  const name = (await readdir(f.directory)).find((name) => name.endsWith(".json"));
  assert(name);
  const file = path.join(f.directory, name);
  await writeFile(file, "{broken", { mode: 0o600 });
  assert.deepEqual(await f.cache().get("tools", load, strings), ["2"]);
  await chmod(file, 0o644);
  await assert.rejects(f.cache().get("tools", load, strings), /LINEAR_PREFLIGHT_CACHE_UNSAFE/);
});

void test("cache directory symlinks are rejected without touching the target", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.directory, "link");
  await symlink(f.directory, link);
  const cache = new LinearPreflightCache({ directory: link, scope: async () => scope });
  await assert.rejects(
    cache.get("tools", async () => ["get_project"], strings),
    /LINEAR_PREFLIGHT_CACHE_UNSAFE/,
  );
});

void test("an old lock still owned by a live loader cannot be stolen", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let competingLoads = 0;
  const first = f.cache().get(
    "tools",
    async () => {
      entered.resolve();
      await release.promise;
      return ["first"];
    },
    strings,
  );
  await entered.promise;
  const name = (await readdir(f.directory)).find((name) => name.endsWith(".lock"));
  assert(name);
  await utimes(path.join(f.directory, name), new Date(0), new Date(0));
  const second = f.cache().get(
    "tools",
    async () => {
      competingLoads++;
      return ["second"];
    },
    strings,
  );
  try {
    await delay(250);
    assert.equal(competingLoads, 0);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
});

void test("cleanup from a replaced lock cannot remove its new owner's lock", async (t) => {
  const f = await fixture(t);
  const enteredFirst = deferred();
  const releaseFirst = deferred();
  const enteredSecond = deferred();
  const releaseSecond = deferred();
  let competingLoads = 0;
  const first = f.cache().get(
    "tools",
    async () => {
      enteredFirst.resolve();
      await releaseFirst.promise;
      throw Error("SYNTHETIC_LOAD_FAILURE");
    },
    strings,
  );
  const firstFailure = assert.rejects(first);
  await enteredFirst.promise;
  const name = (await readdir(f.directory)).find((name) => name.endsWith(".lock"));
  assert(name);
  await rm(path.join(f.directory, name), { recursive: true, force: true });
  const second = f.cache().get(
    "tools",
    async () => {
      enteredSecond.resolve();
      await releaseSecond.promise;
      return ["second"];
    },
    strings,
  );
  await enteredSecond.promise;
  releaseFirst.resolve();
  await firstFailure;
  const third = f.cache().get(
    "tools",
    async () => {
      competingLoads++;
      return ["third"];
    },
    strings,
  );
  try {
    await delay(250);
    assert.equal(competingLoads, 0);
  } finally {
    releaseSecond.resolve();
    await Promise.allSettled([second, third]);
  }
});

void test("crash leftovers are removed without deleting live staged writes or locks", async (t) => {
  const f = await fixture(t);
  await f.cache().get("tools", async () => ["get_project"], strings);
  const file = (await readdir(f.directory)).find((name) => name.endsWith(".json"));
  assert(file);
  const dead = 2147483647;
  assert.throws(() => process.kill(dead, 0), { code: "ESRCH" });
  const staged = async (pid: number) => {
    const id = randomUUID();
    const owner = pid + "-" + id + ".owner";
    const directory = file + ".lock." + owner + ".tmp";
    const write = file + "." + pid + "-" + id + ".tmp";
    await mkdir(path.join(f.directory, directory), { mode: 0o700 });
    await writeFile(path.join(f.directory, directory, owner), "", { mode: 0o600 });
    await writeFile(path.join(f.directory, write), "unfinished", { mode: 0o600 });
    return [directory, write];
  };
  const orphaned = await staged(dead);
  const live = await staged(process.pid);
  const published = path.join(f.directory, file + ".lock");
  await mkdir(published, { mode: 0o700 });
  await writeFile(path.join(published, dead + "-" + randomUUID() + ".owner"), "", { mode: 0o600 });
  await f.cache().get(
    "tools",
    async () => {
      throw Error("SYNTHETIC_CACHE_MISS");
    },
    strings,
  );
  const names = await readdir(f.directory);
  for (const name of orphaned) assert(!names.includes(name));
  for (const name of live) assert(names.includes(name));
  assert(!names.includes(file + ".lock"));
});

void test("concurrent callers recover one dead owner's lock without duplicating loads", async (t) => {
  const f = await fixture(t);
  await f.cache().get("tools", async () => ["old"], strings);
  const file = (await readdir(f.directory)).find((name) => name.endsWith(".json"));
  assert(file);
  await rm(path.join(f.directory, file));
  const directory = path.join(f.directory, file + ".lock");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "2147483647-" + randomUUID() + ".owner"), "", {
    mode: 0o600,
  });
  let loads = 0;
  const values = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.cache().get(
        "tools",
        async () => {
          loads++;
          await delay(40);
          return ["fresh"];
        },
        strings,
      ),
    ),
  );
  assert.equal(loads, 1);
  assert(values.every((value) => value[0] === "fresh"));
});

void test("one runtime cannot combine preflight proof from two authorization contexts", async (t) => {
  const f = await fixture(t);
  const cache = f.cache();
  await cache.get("tools", async () => ["first"], strings);
  f.setScope({ ...scope, epoch: "epoch-b" });
  let loads = 0;
  await assert.rejects(
    cache.get(
      "workspace:example",
      async () => {
        loads++;
        return ["second"];
      },
      strings,
    ),
    { message: "LINEAR_AUTH_CONTEXT_CHANGED" },
  );
  assert.equal(loads, 0);
  assert.deepEqual(await f.cache().get("workspace:example", async () => ["second"], strings), [
    "second",
  ]);
});
