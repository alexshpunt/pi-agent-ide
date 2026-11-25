import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { jsonRecord } from "./fixtures/json.ts";

const workerPath = fileURLToPath(import.meta.resolve("#axi/worker.ts"));

/** A worker process with a reply reader keyed by request id. */
function startWorker() {
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "ignore"] });
  const replies = new Map<number, (reply: Record<string, unknown>) => void>();
  const received: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = jsonRecord(line);
    const { id } = reply;
    assert(typeof id === "number");
    received.push(reply);
    replies.get(id)?.(reply);
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return {
    received,
    exited,
    send(message: Record<string, unknown>) {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    reply(id: number) {
      return new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
    },
    end() {
      child.stdin.end();
    },
    kill() {
      child.kill();
    },
  };
}

async function isolatedEnv(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "linear-axi-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("LINEAR_")) env[name] = value;
  return { ...env, PI_CODING_AGENT_DIR: directory, XDG_CONFIG_HOME: directory };
}

void test("each command runs with its own environment and reports its own exit code", async (t) => {
  const env = await isolatedEnv(t);
  const worker = startWorker();
  t.after(() => worker.kill());
  const legacy = worker.reply(1);
  const selected = worker.reply(2);
  const invalid = worker.reply(3);
  worker.send({ id: 1, args: ["auth", "epoch", "--json"], cwd: process.cwd(), env });
  worker.send({
    id: 2,
    args: ["auth", "epoch", "--json"],
    cwd: process.cwd(),
    env: { ...env, LINEAR_AXI_CONNECTION_ID: "11111111-1111-4111-8111-111111111111" },
  });
  worker.send({ id: 3, args: ["issues", "frobnicate"], cwd: process.cwd(), env });
  const [first, second, third] = await Promise.all([legacy, selected, invalid]);
  assert.equal(first.exitCode, 0);
  assert.equal(jsonRecord(first.stdout).state, "legacy");
  assert.equal(second.exitCode, 0);
  assert.equal(jsonRecord(second.stdout).state, "signed-out");
  assert.equal(third.exitCode, 2);
  assert(typeof third.stdout === "string");
  assert.match(third.stdout, /unknown issues command: frobnicate/);
  worker.end();
  // A failed command does not make the worker itself fail.
  assert.equal(await worker.exited, 0);
});

void test("arguments the worker does not run are returned for a separate process", async (t) => {
  const env = await isolatedEnv(t);
  const worker = startWorker();
  t.after(() => worker.kill());
  const inputs: unknown[] = [["--version"], ["--help"], [], ["update"], ["-h"], ["nope"]];
  const replies = inputs.map((_, index) => worker.reply(index + 1));
  inputs.forEach((args, index) => worker.send({ id: index + 1, args, cwd: process.cwd(), env }));
  worker.send({ id: 7, args: ["auth", "epoch"], cwd: process.cwd(), env: { PATH: 1 } });
  replies.push(worker.reply(7));
  for (const reply of await Promise.all(replies)) assert.equal(reply.unsupported, true);
  worker.end();
  assert.equal(await worker.exited, 0);
});

void test("output beyond the requested bound is not returned", async (t) => {
  const env = await isolatedEnv(t);
  const worker = startWorker();
  t.after(() => worker.kill());
  const reply = worker.reply(1);
  worker.send({ id: 1, args: ["issues", "frobnicate"], cwd: process.cwd(), env, maxBytes: 10 });
  assert.deepEqual(await reply, { id: 1, overflow: true });
  worker.end();
  await worker.exited;
});

void test("cancelling a command aborts its network request and drops its reply", async (t) => {
  const env = await isolatedEnv(t);
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => (arrived = resolve));
  let closed!: () => void;
  const aborted = new Promise<void>((resolve) => (closed = resolve));
  // The Linear endpoint accepts the request and never answers.
  const server = createServer((request) => {
    request.on("close", closed);
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const worker = startWorker();
  t.after(() => worker.kill());
  worker.send({
    id: 1,
    args: ["issues", "view", "ENG-1"],
    cwd: process.cwd(),
    env: {
      ...env,
      LINEAR_AXI_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
      LINEAR_AXI_MCP_TOKEN: "test-token",
    },
  });
  await requested;
  worker.send({ id: 1, cancel: true });
  await aborted;
  worker.end();
  assert.equal(await worker.exited, 0);
  assert.deepEqual(worker.received, []);
});
