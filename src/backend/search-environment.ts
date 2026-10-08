import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SearchEnvironmentProvider } from "pi-agent-search/api/search";
import { remoteLocation } from "./identity.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";

/** Adapt configured SSH scopes to the existing search recipes, without startup probes. */
export function createSshSearchEnvironmentProvider(
  registry: SshBackendRegistry,
): SearchEnvironmentProvider {
  return (request, context) => {
    const scope = registry.resolve(request.path ?? ".", context.cwd);
    if (scope === undefined) return undefined;
    const { backend, location } = scope;
    const own = (source: string, cwd = location.source) => {
      const resolved = registry.resolve(source, cwd);
      if (resolved === undefined || resolved.backend !== backend)
        throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
      return resolved.location;
    };
    return {
      resolve: (cwd, source) => own(source, cwd.includes("://") ? cwd : location.source).source,
      dirname: (source) =>
        remoteLocation(location.target, path.posix.dirname(own(source).path)).source,
      basename: (source) => path.posix.basename(own(source).path),
      isDirectory: async (source, signal) =>
        (await backend.stat(own(source).path, { signal })).kind === "directory",
      readText: async (source, signal) =>
        (await backend.read(own(source).path, { signal })).bytes.toString("utf8"),
      async execute(command, arguments_, cwd, signal) {
        const result = await backend.execute(command, arguments_, own(cwd).path, { signal });
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        };
      },
      async runLines(arguments_, cwd, onLine, signal) {
        const channel = await backend.startProcess("rg", arguments_, own(cwd).path, { signal });
        const decoder = new StringDecoder("utf8");
        const pending: string[] = [];
        let pendingBytes = 0;
        let stderr = "";
        let failure: unknown;
        const consume = (text: string): void => {
          const parts = text.split("\n");
          for (const [index, part] of parts.entries()) {
            pending.push(part);
            pendingBytes += Buffer.byteLength(part);
            if (pendingBytes > 32 * 1024 * 1024)
              throw new SshBackendError("CONTENT_LIMIT", location.source, "not-applied");
            if (index < parts.length - 1) {
              onLine(pending.join(""));
              pending.length = 0;
              pendingBytes = 0;
            }
          }
        };
        const output = (async (): Promise<void> => {
          try {
            for await (const chunk of channel.stdout) consume(decoder.write(chunk as Buffer));
            consume(decoder.end());
            if (pendingBytes > 0) onLine(pending.join(""));
          } catch (error) {
            failure = error;
            await channel.stop();
          }
        })();
        const diagnostics = (async (): Promise<void> => {
          for await (const chunk of channel.stderr) {
            stderr += (chunk as Buffer).toString("utf8");
            if (stderr.length > 65536) stderr = stderr.slice(-65536);
          }
        })();
        try {
          try {
            await channel.end();
          } catch (error) {
            // A short read-only command can finish before EOF reaches its unused stdin.
            // Only the authoritative completion below may establish its exit status.
            if (!(error instanceof SshBackendError) || error.code !== "INPUT_CLOSED") throw error;
          }
          const result = await channel.completion;
          await Promise.all([output, diagnostics]);
          if (failure !== undefined)
            throw failure instanceof Error
              ? failure
              : new Error("Search output failed.", { cause: failure });
          signal?.throwIfAborted();
          return { code: result.exitCode, stderr };
        } finally {
          await channel.stop();
          await Promise.allSettled([output, diagnostics]);
        }
      },
    };
  };
}
