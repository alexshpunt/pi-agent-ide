import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerDebuggerWithOwner,
  type DebuggerWorkspaceAccess,
} from "#src/plugins/pi-agent-ide-debugger/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { remoteLocation } from "./identity.js";
import { SshBackendError } from "./ssh.js";
import { createSshDebuggerWorkspaceOwner } from "./debugger-workspace-owner.js";

/** Resolve ordinary debugger inputs on their selected target without controller path operations. */
export function createSshDebuggerAccess(registry: SshBackendRegistry): DebuggerWorkspaceAccess {
  return {
    workspace: createSshDebuggerWorkspaceOwner(registry),
    async resolveOptions(input, contextCwd, signal) {
      signal?.throwIfAborted();
      const programOwner = registry.resolve(input.program);
      const requestedCwd =
        input.cwd ??
        (programOwner
          ? remoteLocation(programOwner.location.target, programOwner.backend.target.workspace)
              .source
          : contextCwd);
      const cwd = registry.resolve(requestedCwd, contextCwd);
      if (!cwd) {
        if ([requestedCwd, input.program, input.source].some((value) => value?.includes("://")))
          throw new SshBackendError("UNSUPPORTED_SOURCE", input.program, "not-applied");
        return undefined;
      }
      const program = registry.resolve(input.program, cwd.location.source);
      const source = registry.resolve(input.source ?? input.program, cwd.location.source);
      if (
        !program ||
        !source ||
        program.location.target !== cwd.location.target ||
        source.location.target !== cwd.location.target
      )
        throw new SshBackendError("UNSUPPORTED_SOURCE", input.program, "not-applied");
      await program.backend.stat(program.location.path, { signal });
      if (source.location.source !== program.location.source)
        await source.backend.stat(source.location.path, { signal });
      return {
        adapter: input.adapter,
        program: program.location.source,
        sourceFile: source.location.source,
        cwd: cwd.location.source,
        args: input.args ?? [],
        ...(input.mainClass === undefined ? {} : { mainClass: input.mainClass }),
      };
    },
  };
}

/** Register target-owned debugger resources without connecting during extension load. */
export default async function registerOwnedDebugger(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerDebuggerWithOwner(pi, createSshDebuggerAccess(registry));
}
