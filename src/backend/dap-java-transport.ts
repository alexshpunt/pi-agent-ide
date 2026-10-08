import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import type { DebugSessionOptions } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import type { OwnedDebugAdapter } from "#src/plugins/pi-agent-ide-debugger/src/workspace-owner.js";
import type { SshBackendRegistry } from "./registry.js";
import { startSshDapTransport, type SshDapTransport } from "./dap-transport.js";
import { SshBackendError } from "./ssh.js";

const readySchema = Type.Object(
  { port: Type.Integer({ minimum: 1, maximum: 65535 }), sourceRoot: Type.String() },
  { additionalProperties: false },
);

/** Start JDT LS/java-debug and the suspended JVM on the selected owner, never a local socket. */
export async function prepareSshJavaDebugger(
  registry: SshBackendRegistry,
  cwd: string,
  options: DebugSessionOptions,
  signal?: AbortSignal,
): Promise<OwnedDebugAdapter> {
  if (options.mainClass === undefined)
    throw new SshBackendError("INVALID_REQUEST", cwd, "not-applied");
  const worker = await readFile(new URL("./dap-java-worker.py", import.meta.url), "utf8");
  const startup = AbortSignal.any([
    ...(signal === undefined ? [] : [signal]),
    AbortSignal.timeout(40_000),
  ]);
  const transport = await startSshDapTransport(registry, cwd, {
    command: "python3",
    args: [
      "-c",
      worker,
      JSON.stringify({
        mainClass: options.mainClass,
        args: options.args,
        sourceFile: options.sourceFile,
      }),
    ],
    signal,
  });
  try {
    const ready = await readReady(transport, cwd, startup);
    startup.throwIfAborted();
    const client = DapClient.fromTransport(transport);
    transport.readable.resume();
    return {
      client,
      adapterID: "java",
      request: "attach",
      launch: {
        hostName: "127.0.0.1",
        port: ready.port,
        timeout: 10_000,
        sourcePaths: [ready.sourceRoot],
      },
      remote: transport.remote,
    };
  } catch (error) {
    await transport.stop();
    throw error;
  }
}

function readReady(
  transport: SshDapTransport,
  cwd: string,
  signal: AbortSignal,
): Promise<{ port: number; sourceRoot: string }> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = (): void => {
      signal.removeEventListener("abort", aborted);
      transport.readable.removeListener("data", received);
      transport.readable.removeListener("end", closed);
      transport.readable.removeListener("error", failed);
    };
    const failed = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const closed = (): void => failed(new SshBackendError("ADAPTER_EXITED", cwd, "not-applied"));
    const aborted = (): void => failed(signal.reason);
    const received = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) {
        if (bytes.length > 4096)
          failed(new SshBackendError("INVALID_RESPONSE", cwd, "not-applied"));
        return;
      }
      transport.readable.pause();
      cleanup();
      try {
        if (newline > 4096) throw new Error("Java startup header limit");
        const ready: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!Value.Check(readySchema, ready)) throw new Error("Invalid Java startup header");
        if (bytes.length > newline + 1) transport.readable.unshift(bytes.subarray(newline + 1));
        resolve(ready);
      } catch {
        reject(new SshBackendError("INVALID_RESPONSE", cwd, "not-applied"));
      }
    };
    transport.readable.on("data", received);
    transport.readable.once("end", closed);
    transport.readable.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    void transport.completion.then(closed, failed);
    if (signal.aborted) aborted();
  });
}
