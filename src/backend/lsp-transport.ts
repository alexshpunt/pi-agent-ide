import { Writable } from "node:stream";
import { callbackify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspOwnerTransport } from "#src/plugins/pi-agent-ide-lsp/index.js";
import { remoteLocation } from "./identity.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { sshProjectEnvironment } from "./process-environment.js";
import { createSshLspFileWatchers } from "./lsp-file-watchers.js";
import { stopOwnedSshProcess } from "./owned-process-stop.js";

/** Lazy LSP stdio on one configured SSH owner, with server file URIs mapped at the boundary. */
export function createSshLspTransport(
  registry: SshBackendRegistry,
  source: string,
): LspOwnerTransport {
  const owner = registry.resolve(source);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
  return {
    async start(input) {
      const current = registry.resolve(input.rootUri);
      if (!current || current.location.target !== owner.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", input.rootUri, "not-applied");
      const command = input.command.map((part) =>
        part.replaceAll("{project}", current.location.path),
      );
      if (!command[0]) throw new TypeError("Language server command is empty");
      const environment = Object.entries(
        await sshProjectEnvironment(
          current.backend,
          current.location.path,
          input.env,
          input.signal,
        ),
      ).map(([key, value]) => `${key}=${value}`);
      const channel = await current.backend.startProcess(
        "env",
        [...environment, ...command],
        current.location.path,
        { signal: input.signal },
      );
      const stdin = new Writable({
        write: callbackify(async (chunk: Buffer, _encoding: BufferEncoding): Promise<void> => {
          await channel.write(chunk);
        }),
        final: callbackify(async (): Promise<void> => {
          await channel.end();
        }),
      });
      return {
        stdin,
        stdout: channel.stdout,
        stderr: channel.stderr,
        completion: channel.completion,
        remote: { target: current.location.target, pid: channel.pid },
        async stop() {
          try {
            await stopOwnedSshProcess(channel, registry, input.rootUri);
          } finally {
            stdin.destroy();
          }
        },
      };
    },
    fileWatchers(rootUri, changed, failed) {
      const current = registry.resolve(rootUri);
      if (!current || current.location.target !== owner.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", rootUri, "not-applied");
      return createSshLspFileWatchers(registry, rootUri, changed, failed);
    },
    toServerUri(uri) {
      if (!uri.startsWith("ssh://")) {
        if (uri.startsWith("file://"))
          throw new SshBackendError("UNSUPPORTED_SOURCE", uri, "not-applied");
        return uri;
      }
      const location = registry.resolve(uri);
      if (!location || location.location.target !== owner.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", uri, "not-applied");
      return pathToFileURL(location.location.path).href;
    },
    fromServerUri(uri) {
      if (!uri.startsWith("file://")) return uri;
      return remoteLocation(owner.location.target, fileURLToPath(uri)).source;
    },
  };
}
