import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerGitChangesWithExecutor,
  type GitCommandExecutor,
} from "#src/plugins/pi-agent-ide-changes/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";

/** Register Git commands and text reads on the explicitly configured resource owner. */
export default async function registerOwnedGit(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerGitChangesWithExecutor(pi, createOwnedGitExecutor(pi, registry));
}

/** Bind Git commands and blob storage to each canonical resource owner. */
export function createOwnedGitExecutor(
  pi: Pick<ExtensionAPI, "exec">,
  registry: SshBackendRegistry,
): GitCommandExecutor {
  const exec = async (
    command: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ) => {
    const owner = registry.resolve(options.cwd);
    if (!owner) {
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(options.cwd))
        throw new Error(`Unsupported Git resource: ${options.cwd}`);
      return pi.exec(command, args, options);
    }
    const result = await owner.backend.execute(command, args, owner.location.path, options);
    return {
      code: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  };
  return {
    exec,
    async writeIndex(update, options) {
      const owner = registry.resolve(options.cwd);
      if (!owner) return false;
      await owner.backend.writeGitIndex(owner.location.path, update, options);
      return true;
    },

    async readText(source, signal) {
      const owner = registry.resolve(source);
      if (owner)
        return (await owner.backend.read(owner.location.path, { signal })).bytes.toString("utf8");
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source))
        throw new Error(`Unsupported Git resource: ${source}`);
      return readFile(source, { encoding: "utf8", signal });
    },
  };
}
