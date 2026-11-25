import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "github-quota-"));
  dirs.push(dir);
  return dir;
}
const url = "https://api.github.com/repos/fixture/repo";
const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "60" } });
const ok = () => new Response("{}");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("confirmed cooldown prevents later HTTP across two independent processes", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(429, { "retry-after": "60" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const target = `http://127.0.0.1:${port}/resource`;
    const dir = await directory();
    const gate = new GithubRequestCoordinator({ directory: dir });
    await gate.fetch("user:fixture", target, {}, { fetcher: fetch });
    const run = promisify(execFile);
    const worker = fileURLToPath(new URL("./fixtures/rate-worker.mjs", import.meta.url));
    for (let i = 0; i < 2; i++) {
      const result = await run(process.execPath, [
        "--experimental-transform-types",
        worker,
        dir,
        target,
        "user:fixture",
      ]);
      const output = JSON.parse(result.stdout) as {
        rateLimit?: { retryAfterMs?: number; resetAt?: number };
      };
      expect(output).toMatchObject({ code: "GH_RATE_LIMITED", effect: "not-applied" });
      expect(output.rateLimit?.retryAfterMs).toBeGreaterThan(50_000);
      expect(output.rateLimit?.resetAt).toBeGreaterThan(Date.now());
    }
    expect(calls).toBe(1);
    // Other quota owners do not inherit this user's cooldown.
    await gate.fetch("user:another", target, {}, { fetcher: fetch });
    expect(calls).toBe(2);
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect(await readFile(file, "utf8")).not.toContain("user:fixture");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("primary exhaustion stops its bucket but not another bucket", async () => {
  const gate = new GithubRequestCoordinator({ directory: null });
  const send = vi.fn(
    async () =>
      new Response("{}", {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
          "x-ratelimit-resource": "search",
        },
      }),
  );
  await gate.fetch("user:a", "https://api.github.com/search/issues", {}, { fetcher: send });
  await expect(
    gate.fetch("user:a", "https://api.github.com/search/issues?q=b", {}, { fetcher: send }),
  ).rejects.toMatchObject({ code: "GH_RATE_LIMITED" });
  await gate.fetch("user:a", url, {}, { fetcher: async () => ok() });
  expect(send).toHaveBeenCalledTimes(1);
});

test("body-confirmed secondary limits share REST and GraphQL admission", async () => {
  const gate = new GithubRequestCoordinator({ directory: null });
  const response = new Response("{}", {
    status: 403,
    headers: { "x-ratelimit-remaining": "4000" },
  });
  await gate.observe("user:a", url, response, {
    message: "You have exceeded a secondary rate limit.",
  });
  const send = vi.fn(async () => ok());
  await expect(
    gate.fetch(
      "user:a",
      "https://api.github.com/graphql",
      { method: "POST" },
      { readOnly: true, fetcher: send },
    ),
  ).rejects.toMatchObject({ code: "GH_RATE_LIMITED", rateLimit: { requestsRemaining: 4000 } });
  expect(send).not.toHaveBeenCalled();
});

test("healthy operations are bounded and writes are paced without replay", async () => {
  const gate = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 40 });
  let active = 0,
    peak = 0;
  const sent: number[] = [];
  const send = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    sent.push(Date.now());
    await sleep(12);
    active--;
    return ok();
  });
  await Promise.all(
    Array.from({ length: 4 }, () =>
      gate.fetch("user:a", url, { method: "PATCH" }, { fetcher: send }),
    ),
  );
  expect(peak).toBe(1);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    sent.slice(1).every((time, i) => {
      const previous = sent.at(i);
      return previous !== undefined && time - previous >= 39;
    }),
  ).toBe(true);
});

test("cancelled queued mutation is never dispatched", async () => {
  const gate = new GithubRequestCoordinator({ directory: null });
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gate.fetch(
    "user:a",
    url,
    {},
    {
      fetcher: async () => {
        await blocker;
        return ok();
      },
    },
  );
  await sleep(10);
  const abort = new AbortController();
  const send = vi.fn(async () => ok());
  const pending = gate.fetch(
    "user:a",
    url,
    { method: "PATCH", signal: abort.signal },
    { fetcher: send },
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: "GH_CANCELLED",
    effect: "not-applied",
  });
  abort.abort();
  await rejected;
  release();
  await first;
  expect(send).not.toHaveBeenCalled();
});

test("API and release upload hosts share the same upstream core budget", async () => {
  const gate = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 });
  const send = vi.fn(
    async () =>
      new Response("{}", {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
          "x-ratelimit-resource": "core",
        },
      }),
  );
  await gate.fetch(
    "installation:1:2",
    "https://uploads.github.com/repos/o/r/releases/1/assets",
    { method: "POST" },
    { fetcher: send },
  );
  await expect(gate.fetch("installation:1:2", url, {}, { fetcher: send })).rejects.toMatchObject({
    code: "GH_RATE_LIMITED",
  });
  await gate.fetch(
    "installation:1:2",
    "https://objects.githubusercontent.com/fixture",
    {},
    { fetcher: send },
  );
  expect(send).toHaveBeenCalledTimes(2);
});

test("the absolute reset survives the 24-hour relative presentation bound", async () => {
  let now = Date.UTC(2030, 0, 1);
  const resetAt = now + 48 * 3600_000;
  const gate = new GithubRequestCoordinator({ directory: null, now: () => now });
  const headers = {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(resetAt / 1000),
    "x-ratelimit-resource": "core",
  };
  await gate.fetch("user:a", url, {}, { fetcher: async () => new Response("{}", { headers }) });
  await expect(gate.check("user:a", url)).rejects.toMatchObject({
    rateLimit: { resetAt, retryAfterMs: 86_400_000 },
  });
  now += 30 * 3600_000;
  await expect(gate.check("user:a", url)).rejects.toMatchObject({
    rateLimit: { resetAt, retryAfterMs: 18 * 3600_000 },
  });
  now = resetAt;
  await expect(gate.check("user:a", url)).resolves.toBeUndefined();
});

test("the production default leaves at least one second between writes", async () => {
  const gate = new GithubRequestCoordinator({ directory: null });
  const times: number[] = [];
  const send = vi.fn(async () => {
    times.push(Date.now());
    return ok();
  });
  await gate.fetch("user:a", url, { method: "POST" }, { fetcher: send });
  await gate.fetch("user:a", url, { method: "PATCH" }, { fetcher: send });
  const first = times.at(0);
  const second = times.at(1);
  if (first === undefined || second === undefined) throw new Error("Expected two requests");
  expect(second - first).toBeGreaterThanOrEqual(1000);
  expect(send).toHaveBeenCalledTimes(2);
});

test("queue saturation is an explicit not-sent failure", async () => {
  const gate = new GithubRequestCoordinator({ directory: null, maxQueue: 1, waitTimeoutMs: 0 });
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gate.fetch(
    "user:a",
    url,
    {},
    {
      fetcher: async () => {
        began();
        await hold;
        return ok();
      },
    },
  );
  await started;
  const send = vi.fn(async () => ok());
  try {
    await expect(gate.fetch("user:a", url, {}, { fetcher: send })).rejects.toMatchObject({
      code: "GH_RATE_QUEUE_FULL",
      effect: "not-applied",
    });
    expect(send).not.toHaveBeenCalled();
  } finally {
    release();
    await first;
  }
});
test("unsafe coordination directories fail closed before HTTP", async () => {
  const root = await directory();
  const target = await directory();
  const link = join(root, "link");
  await symlink(target, link);
  const gate = new GithubRequestCoordinator({ directory: link });
  const send = vi.fn(async () => limited());
  await expect(gate.fetch("user:a", url, {}, { fetcher: send })).rejects.toMatchObject({
    code: "GH_RATE_STATE_UNSAFE",
    effect: "not-applied",
  });
  expect(send).not.toHaveBeenCalled();
});
