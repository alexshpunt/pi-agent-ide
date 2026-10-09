import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  resolveExternalToolProjectRoot,
  runConfiguredFormatter,
  runConfiguredProcess,
} from "#src/api/tool-config.js";
import {
  registerFormatterWithOwner,
  FormatterCommandRegistry,
  FORMATTER_RECIPES,
  type FormatterRuntime,
} from "#src/plugins/pi-agent-ide-formatter/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { createSshToolConfigAccess } from "./tool-config-access.js";
import { createSshConfiguredProcessAccess } from "./configured-process.js";
import { sshProjectExecutableAvailability } from "./process-environment.js";
import { inspectSshRecipeEvidence } from "./recipe-evidence.js";
import { resolveSshToolProject } from "./tool-project.js";
import { SshBackendError } from "./ssh.js";

/** Keep formatter selection, command execution and guarded stdout publication with their owner. */
export function createOwnedFormatterRuntime(registry: SshBackendRegistry): FormatterRuntime {
  const layerAccess = createSshToolConfigAccess(registry);
  const processAccess = createSshConfiguredProcessAccess(registry);
  const registries = new Map<string, Promise<FormatterCommandRegistry>>();
  return {
    async resolveProject(source, cwd) {
      if (source.startsWith("ssh://") || cwd.startsWith("ssh://")) {
        const owner = registry.resolve(source, cwd);
        if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        const current = registry.resolve(cwd);
        if (current && current.location.target !== owner.location.target)
          throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        return resolveSshToolProject(
          owner.backend,
          owner.location.path,
          current?.location.path,
          "formatters",
          FORMATTER_RECIPES,
        );
      }
      if (source.includes("://") || cwd.includes("://"))
        throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
      const project = await resolveExternalToolProjectRoot(
        cwd,
        source,
        "formatters",
        FORMATTER_RECIPES,
      );
      return project === undefined
        ? undefined
        : { cwd: project, external: project !== path.resolve(cwd) };
    },
    async loadRegistry(cwd, external) {
      const key = JSON.stringify([cwd, external]);
      let pending = registries.get(key);
      if (!pending) {
        const owner = registry.resolve(cwd);
        pending = FormatterCommandRegistry.fromDirectory(cwd, {
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
        registries.set(key, pending);
      }
      return pending;
    },
    async run(config, projectRoot, source) {
      const owner = registry.resolve(source);
      if (!owner) {
        if (source.includes("://") || projectRoot.includes("://"))
          throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        return runConfiguredFormatter(config, { projectRoot, filePath: source });
      }
      const before = await owner.backend.read(owner.location.path);
      const result = await runConfiguredProcess(config.run, {
        projectRoot,
        filePath: source,
        processAccess,
      });
      const after = await owner.backend.read(owner.location.path);
      if (!result.ok) return { ok: false, changed: !after.bytes.equals(before.bytes) };
      if (config.output === "stdout") {
        if (after.version !== before.version)
          throw new SshBackendError("CONFLICT", source, "not-applied");
        const output = Buffer.from(result.stdout);
        if (!output.equals(before.bytes))
          await owner.backend.write(owner.location.path, output, before.version);
        return { ok: true, changed: !output.equals(before.bytes) };
      }
      // Native commands own their writes. Observe them without overwriting a concurrent writer.
      return { ok: true, changed: !after.bytes.equals(before.bytes) };
    },
  };
}

/** Register lazy owner-aware ordinary formatter hooks. */
export default async function registerOwnedFormatter(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerFormatterWithOwner(pi, createOwnedFormatterRuntime(registry));
}
