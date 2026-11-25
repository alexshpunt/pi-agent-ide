#!/usr/bin/env node
/**
 * Long-lived command runner for clients that call linear-axi many times in a row.
 *
 * A fresh `linear-axi` process spends about a second loading its modules before any network
 * request. The worker loads them once and runs each command it is sent in the same process.
 *
 * Protocol: newline-delimited JSON on stdin and stdout.
 * - `{"id":1,"args":["issues","view","ENG-1"],"cwd":"/repo","env":{...},"maxBytes":2097152}`
 *   runs a command with exactly that working directory and environment.
 * - `{"id":1,"cancel":true}` aborts the command's network requests and drops its response.
 * - Replies are `{"id":1,"stdout":"...","exitCode":0}`, `{"id":1,"unsupported":true}` for
 *   arguments the worker does not run (the client starts `linear-axi` instead), or
 *   `{"id":1,"overflow":true}` when the output exceeds `maxBytes`.
 * The worker exits when stdin closes and its commands have finished.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isWorkerCommand, runCommand } from "./cli.ts";
import { configureNetwork } from "./lib/network.ts";
import { asRecord } from "./types.ts";

interface WorkerRequest {
  readonly id: number;
  readonly args?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly maxBytes?: unknown;
}

const requestSignal = new AsyncLocalStorage<AbortSignal>();
const running = new Map<number, AbortController>();
let closed = false;

// Commands resolve their own executable path for display; report the CLI, not the worker.
process.argv[1] = join(dirname(fileURLToPath(import.meta.url)), "bin.js");
configureNetwork();

// Every request made while a command runs carries that command's cancellation signal, so a
// cancelled command stops its remaining network steps like a terminated process would.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const signal = requestSignal.getStore();
  if (!signal) return originalFetch(input, init);
  const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return originalFetch(input, { ...init, signal: own ? AbortSignal.any([own, signal]) : signal });
};

function reply(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function environment(value: unknown): NodeJS.ProcessEnv | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string"))
    return undefined;
  return Object.fromEntries(entries);
}

async function execute(request: WorkerRequest): Promise<void> {
  const { args, cwd } = request;
  const env = environment(request.env);
  const maxBytes =
    typeof request.maxBytes === "number" && request.maxBytes > 0 ? request.maxBytes : Infinity;
  if (running.has(request.id) || !isWorkerCommand(args) || typeof cwd !== "string" || !env) {
    reply({ id: request.id, unsupported: true });
    return;
  }
  const controller = new AbortController();
  running.set(request.id, controller);
  const chunks: string[] = [];
  let bytes = 0;
  const output = { overflow: false };
  const stdout = {
    write(chunk: string | Uint8Array): boolean {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) {
        output.overflow = true;
        controller.abort(new Error("LINEAR_AXI_OUTPUT_TOO_LARGE"));
      } else chunks.push(text);
      return true;
    },
  };
  try {
    const exitCode = await requestSignal.run(controller.signal, () =>
      runCommand(args, {
        cwd,
        env,
        stdout,
        stdin: Readable.from([]),
      }),
    );
    if (output.overflow) reply({ id: request.id, overflow: true });
    else if (!controller.signal.aborted)
      reply({ id: request.id, stdout: chunks.join(""), exitCode });
  } finally {
    running.delete(request.id);
    finishIfIdle();
  }
}

function finishIfIdle(): void {
  if (!closed || running.size > 0) return;
  // The SDK records each command's error exit code globally; the worker itself succeeded.
  process.exitCode = 0;
  // Open handles of finished commands must not keep an abandoned worker alive.
  process.stdout.end(() => process.exit());
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  const record = asRecord(value);
  if (!record || typeof record.id !== "number" || !Number.isSafeInteger(record.id)) return;
  const { id, cancel, args, cwd, env, maxBytes } = record;
  if (cancel === true) {
    running.get(id)?.abort(new Error("LINEAR_AXI_CANCELLED"));
    return;
  }
  void execute({ id, args, cwd, env, maxBytes });
});
input.on("close", () => {
  closed = true;
  finishIfIdle();
});
