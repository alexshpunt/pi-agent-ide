import { Writable } from "node:stream";
import { callbackify } from "node:util";
import type { LspOwnerTransport } from "#src/plugins/pi-agent-ide-lsp/index.ts";
import { remoteLocationFromFileUri, sshFileUri, sshNativePath } from "./native-path.ts";
import { targetOs } from "./ssh-transport.ts";
import { remoteLocation } from "./identity.ts";
import type { SshBackendRegistry } from "./registry.ts";
import { SshBackendError } from "./ssh.ts";
import { missingSshExecutable, sshProjectEnvironment } from "./process-environment.ts";
import { createSshLspFileWatchers } from "./lsp-file-watchers.ts";
import { stopOwnedSshProcess } from "./owned-process-stop.ts";

/** Lazy LSP stdio on one configured SSH owner, with server file URIs mapped at the boundary. */
export function createSshLspTransport(
  registry: SshBackendRegistry,
  source: string,
): LspOwnerTransport {
  const owner = registry.resolve(source);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
  const os = targetOs(owner.backend.target);
  const resolve = (uri: string) => {
    const current = registry.resolve(uri);
    if (!current || current.location.target !== owner.location.target)
      throw new SshBackendError("UNSUPPORTED_SOURCE", uri, "not-applied");
    return current;
  };
  return {
    async start(input) {
      const current = resolve(input.rootUri);
      const project = sshNativePath(current.location.path, os);
      const [command, ...args] = input.command.map((part) => part.replaceAll("{project}", project));
      if (!command) throw new TypeError("Language server command is empty");
      const env = await sshProjectEnvironment(
        current.backend,
        current.location.path,
        input.env,
        input.signal,
      );
      const channel = await current.backend
        .startProcess(command, args, current.location.path, { signal: input.signal, env })
        .catch((error: unknown) => {
          throw missingSshExecutable(error, command, current.location.target);
        });
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
    // The current watcher is backed by Linux inotify, not Windows filesystem events.
    ...(os === "linux" && {
      fileWatchers(rootUri, changed, failed) {
        resolve(rootUri);
        return createSshLspFileWatchers(registry, rootUri, changed, failed);
      },
    }),
    toServerUri(uri) {
      if (!uri.startsWith("ssh://")) {
        if (uri.startsWith("file://"))
          throw new SshBackendError("UNSUPPORTED_SOURCE", uri, "not-applied");
        return uri;
      }
      return sshFileUri(resolve(uri).location.path, os);
    },
    toServerPath(uri) {
      return sshNativePath(resolve(uri).location.path, os);
    },
    fromServerPath(file) {
      return remoteLocation(owner.location.target, file, os).source;
    },
    fromServerUri(uri) {
      if (!uri.startsWith("file://")) return uri;
      return remoteLocationFromFileUri(owner.location.target, uri, os).source;
    },
  };
}
