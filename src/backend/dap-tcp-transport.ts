import { readFile } from "node:fs/promises";
import type { SshBackendRegistry } from "./registry.js";
import { startSshDapTransport, type SshDapTransport } from "./dap-transport.js";
import { SshBackendError } from "./ssh.js";

let worker: Promise<string> | undefined;

/** Relay an owned TCP-only adapter through target-loopback, never a controller/public socket. */
export async function startSshTcpDapTransport(
  registry: SshBackendRegistry,
  cwd: string,
  input: {
    readonly kind: "delve" | "ruby" | "julia";
    readonly program: string;
    readonly args: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<SshDapTransport> {
  input.signal?.throwIfAborted();
  const configuration = Buffer.from(
    JSON.stringify({ kind: input.kind, program: input.program, args: input.args }) + "\n",
  );
  if (configuration.byteLength > 65536) throw new SshBackendError("BYTE_LIMIT", cwd, "not-applied");
  worker ??= readFile(new URL("./dap-tcp-worker.py", import.meta.url), "utf8");
  const transport = await startSshDapTransport(registry, cwd, {
    command: "python3",
    args: ["-c", await worker],
    signal: input.signal,
  });
  try {
    // Observe write errors during the handoff before DapClient installs its own listeners.
    await new Promise<void>((resolve, reject) => {
      transport.writable.once("error", reject);
      transport.writable.write(configuration, (error) => (error ? reject(error) : resolve()));
    });
    input.signal?.throwIfAborted();
    return transport;
  } catch (error) {
    await transport.stop();
    throw error;
  }
}
