import path from "node:path";
import type { ConfiguredProcessAccess } from "#src/api/tool-config.ts";
import type { SshBackendRegistry } from "./registry.ts";
import { missingSshExecutable, sshProjectEnvironment } from "./process-environment.ts";
import { sshNativePath } from "./native-path.ts";
import { targetOs } from "./ssh-transport.ts";
import { SshBackendError } from "./ssh.ts";
import { runOwnedSshCommand } from "./owned-command.ts";

/** Run configured exact argv in the source owner's project environment. */
export function createSshConfiguredProcessAccess(
  registry: SshBackendRegistry,
): ConfiguredProcessAccess {
  return {
    async run(config, context) {
      context.signal?.throwIfAborted();
      const project = registry.resolve(context.projectRoot);
      const file = registry.resolve(context.filePath);
      if (!project || !file || project.location.target !== file.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", context.filePath, "not-applied");
      const os = targetOs(project.backend.target);
      const paths = os === "windows" ? path.win32 : path.posix;
      const root = sshNativePath(project.location.path, os);
      const source = sshNativePath(file.location.path, os);
      const expand = (value: string) =>
        value
          .replaceAll("{project}", root)
          .replaceAll("{fileDir}", paths.dirname(source))
          .replaceAll("{relativeFile}", paths.relative(root, source))
          .replaceAll("{file}", source);
      const [command, ...args] = config.command.map(expand);
      if (!command) throw new TypeError("Configured process command is empty");
      const env = await sshProjectEnvironment(
        project.backend,
        project.location.path,
        config.env,
        context.signal,
      );
      context.signal?.throwIfAborted();
      const result = await runOwnedSshCommand(
        {
          ...project.backend.target,
          workspace:
            config.cwd === "file" ? path.posix.dirname(file.location.path) : project.location.path,
        },
        command,
        args,
        context.filePath,
        {
          signal: context.signal,
          env,
          timeoutMs: config.timeoutMs ?? 30_000,
          maxBytes: 20 * 1024 * 1024,
          closeInput: true,
          ...(context.input === undefined ? {} : { input: Buffer.from(context.input) }),
          effect: "unknown",
        },
      ).catch((error: unknown) => {
        throw missingSshExecutable(error, command, project.location.target);
      });
      return {
        ok: (config.successExitCodes ?? [0]).includes(result.exitCode),
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    },
  };
}
