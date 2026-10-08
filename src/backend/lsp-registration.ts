import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveExternalToolProjectRoot } from "#src/api/tool-config.js";
import {
  registerLspWithOwner,
  LspServerRegistry,
  LSP_RECIPES,
} from "#src/plugins/pi-agent-ide-lsp/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { createSshToolConfigAccess } from "./tool-config-access.js";
import { createSshLspWorkspaceOwner } from "./lsp-workspace-owner.js";
import { sshProjectExecutableAvailability } from "./process-environment.js";
import { SshBackendError } from "./ssh.js";
import { resolveSshToolProject } from "./tool-project.js";
import { inspectSshRecipeEvidence } from "./recipe-evidence.js";

/** Load ordinary LSP providers with lazy target-owned configuration and stdio. */
export default async function registerOwnedLsp(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  const workspace = createSshLspWorkspaceOwner(registry);
  await registerLspWithOwner(pi, {
    workspace: (cwd) => (cwd.startsWith("ssh://") ? workspace : undefined),
    async loadRegistry(cwd, external, signal) {
      signal?.throwIfAborted();
      const owner = registry.resolve(cwd);
      if (owner) {
        return LspServerRegistry.fromPackageDir(cwd, {
          signal,
          layerAccess: createSshToolConfigAccess(registry, signal),
          includeGlobal: !external,
          requireBuiltInEvidence: external,
          recipes: LSP_RECIPES,
          recipeEvidence: (recipes) =>
            inspectSshRecipeEvidence(owner.backend, owner.location.path, recipes, signal),
          executableAvailability: (configs) =>
            sshProjectExecutableAvailability(owner.backend, owner.location.path, configs, signal),
        });
      }
      if (cwd.includes("://")) throw new SshBackendError("UNSUPPORTED_SOURCE", cwd, "not-applied");
      return LspServerRegistry.fromPackageDir(
        external ? cwd : (process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd),
        {
          signal,
          includeGlobal: !external,
          requireBuiltInEvidence: external,
          recipes: LSP_RECIPES,
        },
      );
    },
    async resolveProject(filePath, cwd, signal) {
      signal?.throwIfAborted();
      if (filePath.startsWith("ssh://") || cwd.startsWith("ssh://")) {
        const owner = registry.resolve(filePath, cwd);
        if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", filePath, "not-applied");
        const root = registry.resolve(cwd);
        if (root && root.location.target !== owner.location.target)
          throw new SshBackendError("UNSUPPORTED_SOURCE", filePath, "not-applied");
        return resolveSshToolProject(
          owner.backend,
          owner.location.path,
          root?.location.path,
          "lsp-servers",
          LSP_RECIPES,
          signal,
        );
      }
      const project = await resolveExternalToolProjectRoot(
        cwd,
        filePath,
        "lsp-servers",
        LSP_RECIPES,
        signal,
      );
      return project === undefined
        ? undefined
        : { cwd: project, external: project !== path.resolve(cwd) };
    },
  });
}
