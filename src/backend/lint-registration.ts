import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveExternalToolProjectRoot } from "#src/api/tool-config.js";
import {
  registerLintWithOwner,
  LintCommandRegistry,
  LINTER_RECIPES,
  runConfiguredLinter,
  type LintRuntime,
} from "#src/plugins/pi-agent-ide-lint/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { createSshToolConfigAccess } from "./tool-config-access.js";
import { createSshConfiguredProcessAccess } from "./configured-process.js";
import { sshProjectExecutableAvailability } from "./process-environment.js";
import { inspectSshRecipeEvidence } from "./recipe-evidence.js";
import { resolveSshToolProject } from "./tool-project.js";
import { SshBackendError } from "./ssh.js";

/** Select owner tool layers and normalize only diagnostic file identities, never message text. */
export function createOwnedLintRuntime(registry: SshBackendRegistry): LintRuntime {
  const layerAccess = createSshToolConfigAccess(registry);
  const processAccess = createSshConfiguredProcessAccess(registry);
  return {
    async resolveProject(source, cwd) {
      if (source.startsWith("ssh://") || cwd.startsWith("ssh://")) {
        const owner = registry.resolve(source, cwd);
        if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        const current = registry.resolve(cwd);
        if (current && current.location.target !== owner.location.target)
          throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        const project = await resolveSshToolProject(
          owner.backend,
          owner.location.path,
          current?.location.path,
          "linters",
          LINTER_RECIPES,
        );
        return project ? { projectRoot: project.cwd, external: project.external } : undefined;
      }
      if (source.includes("://") || cwd.includes("://"))
        throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
      const project = await resolveExternalToolProjectRoot(cwd, source, "linters", LINTER_RECIPES);
      return project === undefined
        ? undefined
        : { projectRoot: project, external: project !== path.resolve(cwd) };
    },
    async loadRegistry(cwd, external) {
      const owner = registry.resolve(cwd);
      return LintCommandRegistry.fromDirectory(cwd, {
        includeGlobal: !external,
        requireBuiltInEvidence: true,
        ...(owner
          ? {
              layerAccess,
              executableAvailability: (configs) =>
                sshProjectExecutableAvailability(owner.backend, owner.location.path, configs),
              recipeEvidence: (recipes) =>
                inspectSshRecipeEvidence(owner.backend, owner.location.path, recipes),
            }
          : {}),
      });
    },
    async run(config, context) {
      const owner = registry.resolve(context.filePath);
      if (!owner) return runConfiguredLinter(config, context);
      const project = registry.resolve(context.projectRoot);
      if (!project || project.location.target !== owner.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", context.filePath, "not-applied");
      const cwd =
        config.check.cwd === "file"
          ? path.posix.dirname(owner.location.path)
          : project.location.path;
      return runConfiguredLinter(config, {
        ...context,
        processAccess,
        acceptsFile(source) {
          if (source.startsWith("ssh://")) {
            const diagnostic = registry.resolve(source);
            return (
              diagnostic?.location.target === owner.location.target &&
              diagnostic.location.path === owner.location.path
            );
          }
          const native = source.startsWith("file:") ? fileURLToPath(source) : source;
          if (native.includes("://")) return false;
          return path.posix.resolve(cwd, native) === owner.location.path;
        },
      });
    },
  };
}

/** Register lazy owner-aware ordinary lint checks and diagnostic resources. */
export default async function registerOwnedLint(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerLintWithOwner(pi, createOwnedLintRuntime(registry));
}
