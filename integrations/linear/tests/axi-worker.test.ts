import { jsonRecord } from "./fixtures/check.ts";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceError } from "pi-agent-ide/api/resource";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAuthRunner } from "#linear/auth-process.ts";
import { runAxi } from "#linear/axi.ts";
import { stopAxiWorkers } from "#linear/axi-worker.ts";

let cwd: string;
let bin: string;

/** A stand-in worker speaking the backend's protocol; the first argument picks its behavior. */
const worker = String.raw`
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("worker-started", "started");
const requests = new Map();
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.cancel) {
    writeFileSync(requests.get(request.id).env.CANCEL_FILE, "cancelled");
    return;
  }
  requests.set(request.id, request);
  const [command, action] = request.args;
  if (command === "echo")
    reply({ id: request.id, exitCode: 0, stdout: JSON.stringify({
      pid: process.pid, cwd: request.cwd, mark: request.env.LINEAR_TEST_MARK,
      maxBytes: request.maxBytes,
    }) });
  else if (command === "fail")
    reply({ id: request.id, exitCode: 1,
      stdout: "error: LINEAR_OPERATION_CONNECT_FAILED\neffect: not-applied\n" });
  else if (command === "crash") process.exit(3);
  else if (command === "big") reply({ id: request.id, overflow: true });
  else if (command === "auth" && action === "epoch")
    reply({ id: request.id, exitCode: 0, stdout: JSON.stringify({ state: "legacy", epoch: "worker" }) + "\n" });
  else if (command !== "hang") reply({ id: request.id, unsupported: true });
});
`;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "linear-axi-worker-"));
  await mkdir(path.join(cwd, ".pi"));
  await mkdir(path.join(cwd, "dist"));
  bin = path.join(cwd, "dist", "bin.js");
  // The one-process path prints its own marker, so a fallback is visible.
  await writeFile(
    bin,
    'process.stdout.write(process.argv[2] === "auth" ? JSON.stringify({ state: "legacy", epoch: "spawned" }) + "\\n" : "spawned\\n");\n',
  );
  await writeFile(path.join(cwd, "dist", "worker.js"), worker);
  await writeFile(path.join(cwd, ".pi", "linear.json"), JSON.stringify({ axiPath: bin }));
});
afterEach(async () => {
  stopAxiWorkers();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

const echo = async () => {
  const result = jsonRecord(await runAxi(cwd, ["echo"]));
  expect(typeof result.pid).toBe("number");
  return result;
};

test("commands share one worker and each carries the environment of its own call", async () => {
  vi.stubEnv("LINEAR_TEST_MARK", "first");
  const first = await echo();
  vi.stubEnv("LINEAR_TEST_MARK", "second");
  const second = await echo();
  expect(first).toMatchObject({ cwd, mark: "first", maxBytes: 2 * 1024 * 1024 });
  expect(second).toMatchObject({ cwd, mark: "second" });
  expect(second.pid).toBe(first.pid);
});

test("a failed command crosses the worker boundary like a failed process", async () => {
  const error = await runAxi(cwd, ["fail"]).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ResourceError);
  expect(error).toMatchObject({ code: "LINEAR_OPERATION_CONNECT_FAILED", effect: "not-applied" });
});

test("a command past its deadline times out and is cancelled in the worker", async () => {
  const marker = path.join(cwd, "cancelled");
  vi.stubEnv("CANCEL_FILE", marker);
  await expect(runAxi(cwd, ["hang"], undefined, undefined, 300)).rejects.toThrow(
    /^LINEAR_AXI_TIMEOUT$/u,
  );
  await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("cancelled"));
});

test("an aborted command rejects with the abort reason and is cancelled in the worker", async () => {
  const marker = path.join(cwd, "cancelled");
  vi.stubEnv("CANCEL_FILE", marker);
  const controller = new AbortController();
  const running = runAxi(cwd, ["hang"], controller.signal);
  setTimeout(() => controller.abort(new Error("stopped by user")), 200);
  await expect(running).rejects.toThrow("stopped by user");
  await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("cancelled"));
});

test("a worker that exits fails its command and the next command starts a new worker", async () => {
  const before = await echo();
  await expect(runAxi(cwd, ["crash"])).rejects.toThrow(/^LINEAR_AXI_FAILED$/u);
  const after = await echo();
  expect(after.pid).not.toBe(before.pid);
});

test("output the worker refuses as too large is a generic failure", async () => {
  await expect(runAxi(cwd, ["big"])).rejects.toThrow(/^LINEAR_AXI_FAILED$/u);
});

test("arguments the worker does not run start the CLI as a separate process", async () => {
  expect(await runAxi(cwd, ["unknown"])).toBe("spawned\n");
});

test("a leading flag or no arguments start the CLI without starting the worker", async () => {
  expect(await runAxi(cwd, ["--help"])).toBe("spawned\n");
  expect(await runAxi(cwd, [])).toBe("spawned\n");
  await expect(readFile(path.join(cwd, "worker-started"), "utf8")).rejects.toThrow(/ENOENT/u);
  // The marker proves the stand-in worker would record a start: a command it runs does.
  await echo();
  expect(await readFile(path.join(cwd, "worker-started"), "utf8")).toBe("started");
});

test("a rebuilt worker script takes over from the next command", async () => {
  const before = await echo();
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(cwd, "dist", "worker.js"), later, later);
  const after = await echo();
  expect(after.pid).not.toBe(before.pid);
});

test("a backend without a worker script runs every command as its own process", async () => {
  await rm(path.join(cwd, "dist", "worker.js"));
  expect(await runAxi(cwd, ["echo"])).toBe("spawned\n");
});

test("auth status reads use the worker; commands with secret input start the CLI", async () => {
  const run = createAuthRunner(async () => bin);
  expect((await run(cwd, ["epoch"])).epoch).toBe("worker");
  expect(
    (await run(cwd, ["import"], { input: { type: "api-key", token: "test-only" } })).epoch,
  ).toBe("spawned");
});
