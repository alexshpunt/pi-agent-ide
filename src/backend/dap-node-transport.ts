import { readFile } from "node:fs/promises";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import type { OwnedDebugAdapter } from "#src/plugins/pi-agent-ide-debugger/src/workspace-owner.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { startSshDapTransport, type SshDapTransport } from "./dap-transport.js";

/** Keep Node parent and reverse child connections on one exact target-owned Unix server. */
export async function prepareSshNodeDebugger(
  registry: SshBackendRegistry,
  cwd: string,
  launch: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<OwnedDebugAdapter> {
  signal?.throwIfAborted();
  const owner = registry.resolve(cwd);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", cwd, "not-applied");
  const created = await owner.backend.execute(
    "python3",
    ["-c", "import tempfile; print(tempfile.mkdtemp(prefix='pi-agent-ide-node-',dir='/tmp'))"],
    owner.location.path,
    { signal },
  );
  const directory = created.stdout.toString("utf8").trim();
  if (created.exitCode !== 0 || !/^\/tmp\/pi-agent-ide-node-[A-Za-z0-9_-]+$/u.test(directory))
    throw new SshBackendError("INVALID_RESPONSE", cwd, "unknown");
  let server: SshDapTransport | undefined;
  const connections = new Set<SshDapTransport>();
  const startingConnections = new Set<Promise<SshDapTransport>>();
  let stopping: Promise<void> | undefined;
  const isStopping = (): boolean => stopping !== undefined;
  const cleanup = async (): Promise<void> => {
    const removed = await owner.backend.execute(
      "python3",
      ["-c", "import shutil,sys; shutil.rmtree(sys.argv[1])", directory],
      owner.location.path,
    );
    if (removed.exitCode !== 0) throw new SshBackendError("CLEANUP_FAILED", cwd, "unknown");
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        // A reverse request can already be waiting for its native channel's ready frame.
        await Promise.allSettled([...startingConnections]);
        const stopped = await Promise.allSettled(
          [...connections].map((connection) => connection.stop()),
        );
        const failed = stopped.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        try {
          await server?.stop();
        } finally {
          await cleanup();
        }
      }
    })();
    return stopping;
  };
  try {
    const worker = await readFile(new URL("./dap-unix-worker.py", import.meta.url), "utf8");
    server = await startSshDapTransport(registry, cwd, {
      command: "python3",
      args: [
        "-c",
        "import os,sys; script=os.environ.get('PI_JS_DEBUG_PATH','/opt/pi-debug-adapters/js-debug/src/dapDebugServer.js'); os.execvpe('node',['node',script,sys.argv[1]],os.environ)",
        `${directory}/dap.sock`,
      ],
      env: { TMPDIR: directory },
      signal,
    });
    // Server status output is not DAP. Each client uses a separately guarded Unix connection.
    server.readable.resume();
    const adapter = server;
    const identity = adapter.remote.identity;
    if (!identity) throw new SshBackendError("CAPABILITY_UNAVAILABLE", cwd, "not-applied");
    const connect = async (): Promise<SshDapTransport> => {
      if (isStopping()) throw new SshBackendError("SESSION_CLOSED", cwd, "not-applied");
      const starting = startSshDapTransport(registry, cwd, {
        command: "python3",
        args: ["-c", worker, `${directory}/dap.sock`, String(adapter.remote.pid), identity],
        signal,
      });
      startingConnections.add(starting);
      try {
        const transport = await starting;
        connections.add(transport);
        if (isStopping()) throw new SshBackendError("SESSION_CLOSED", cwd, "not-applied");
        return transport;
      } finally {
        startingConnections.delete(starting);
      }
    };
    const primary = await connect();
    return {
      client: DapClient.fromTransport({
        readable: primary.readable,
        writable: primary.writable,
        completion: Promise.race([primary.completion, adapter.completion]),
        stop,
      }),
      connectChild: async () => DapClient.fromTransport(await connect()),
      adapterID: "pwa-node",
      request: "launch",
      remote: adapter.remote,
      launch,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
