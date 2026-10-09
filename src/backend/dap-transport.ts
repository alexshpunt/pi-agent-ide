import { Writable } from "node:stream";
import { callbackify } from "node:util";
import type { DapTransport } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { sshProjectEnvironment } from "./process-environment.js";
import { stopOwnedSshProcess } from "./owned-process-stop.js";

/** Exact target stdio and native lifetime metadata, never a controller process ID. */
export interface SshDapTransport extends DapTransport {
  readonly remote: { readonly target: string; readonly pid: number; readonly identity?: string };
}

/** Start only an explicitly owned target adapter. Arguments are native argv, not resource URIs. */
export async function startSshDapTransport(
  registry: SshBackendRegistry,
  cwd: string,
  input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
): Promise<SshDapTransport> {
  input.signal?.throwIfAborted();
  const owner = registry.resolve(cwd);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", cwd, "not-applied");
  const environment = Object.entries(
    await sshProjectEnvironment(owner.backend, owner.location.path, input.env, input.signal),
  ).map(([key, value]) => `${key}=${value}`);
  const channel = await owner.backend.startProcess(
    "env",
    [...environment, input.command, ...input.args],
    owner.location.path,
    { signal: input.signal },
  );
  // Adapter stderr is not protocol. Drain it without retaining or exposing transport diagnostics.
  channel.stderr.resume();
  const writable = new Writable({
    write: callbackify(async (chunk: Buffer, _encoding: BufferEncoding): Promise<void> => {
      await channel.write(chunk);
    }),
    final: callbackify(async (): Promise<void> => {
      await channel.end();
    }),
  });
  let stopping: Promise<void> | undefined;
  const completion = channel.completion.then((result) => {
    if (result.exitCode !== 0) throw new SshBackendError("ADAPTER_EXITED", cwd, "unknown");
  });
  // Startup and protocol consumers may attach at different times; retain the rejection for both.
  void completion.catch(() => {});
  return {
    readable: channel.stdout,
    writable,
    completion,
    remote: {
      target: owner.location.target,
      pid: channel.pid,
      ...(channel.identity === undefined ? {} : { identity: channel.identity }),
    },
    stop() {
      stopping ??= stopOwnedSshProcess(channel, registry, cwd).finally(() => {
        writable.destroy();
      });
      return stopping;
    },
  };
}
