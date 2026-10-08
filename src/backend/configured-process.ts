import path from "node:path";
import type { ConfiguredProcessAccess } from "#src/api/tool-config.js";
import type { SshBackendRegistry } from "./registry.js";
import { sshProjectEnvironment } from "./process-environment.js";
import { SshBackendError } from "./ssh.js";
import { runOwnedSshCommand } from "./owned-command.js";

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
      const root = project.location.path;
      const source = file.location.path;
      const expand = (value: string) =>
        value
          .replaceAll("{project}", root)
          .replaceAll("{fileDir}", path.posix.dirname(source))
          .replaceAll("{relativeFile}", path.posix.relative(root, source))
          .replaceAll("{file}", source);
      const command = config.command.map(expand);
      const environment = await sshProjectEnvironment(
        project.backend,
        root,
        config.env,
        context.signal,
      );
      context.signal?.throwIfAborted();
      const result = await runOwnedSshCommand(
        {
          ...project.backend.target,
          workspace: config.cwd === "file" ? path.posix.dirname(source) : root,
        },
        "env",
        [...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...command],
        context.filePath,
        {
          signal: context.signal,
          timeoutMs: config.timeoutMs ?? 30_000,
          maxBytes: 20 * 1024 * 1024,
          closeInput: true,
          effect: "unknown",
        },
      );
      return {
        ok: (config.successExitCodes ?? [0]).includes(result.exitCode),
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    },
  };
}
