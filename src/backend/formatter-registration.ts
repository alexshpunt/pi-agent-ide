import path from "node:path";
import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  resolveExternalToolProjectRoot,
  runConfiguredFormatter,
  runConfiguredProcess,
} from "#src/api/tool-config.ts";
import {
  registerFormatterWithOwner,
  FormatterCommandRegistry,
  FORMATTER_RECIPES,
  type FormatterRuntime,
} from "#src/plugins/pi-agent-ide-formatter/index.ts";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.ts";
import { readSshTargets, resolveSshConfigPaths } from "./config.ts";
import { SshBackendRegistry } from "./registry.ts";
import { createSshToolConfigAccess } from "./tool-config-access.ts";
import { createSshConfiguredProcessAccess } from "./configured-process.ts";
import { sshProjectExecutableAvailability } from "./process-environment.ts";
import { inspectSshRecipeEvidence } from "./recipe-evidence.ts";
import { resolveSshToolProject } from "./tool-project.ts";
import { SshBackendError } from "./ssh.ts";
import { localRustfmtAccess } from "#src/plugins/pi-agent-ide-formatter/src/rustfmt.ts";
import { remoteLocation } from "./identity.ts";
import { remotePython, targetOs } from "./ssh-transport.ts";

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
    async rustfmtAccess(projectRoot, source) {
      const owner = registry.resolve(source);
      if (!owner)
        return {
          file: path.join(await realpath(path.dirname(source)), path.basename(source)),
          access: localRustfmtAccess(projectRoot, source),
        };
      const os = targetOs(owner.backend.target);
      const environment = await owner.backend.execute(
        remotePython(
          "import json,os\nhome=os.path.expanduser('~')\nconfig=os.environ.get('APPDATA') if os.name == 'nt' else (os.environ.get('XDG_CONFIG_HOME') or os.path.join(home,'.config'))\nprint(json.dumps([home,os.path.join(config,'rustfmt') if config else '']))",
        ),
        [],
        path.posix.dirname(owner.location.path),
      );
      if (environment.exitCode !== 0)
        throw new SshBackendError("CONFIG_ENVIRONMENT_FAILED", source, "not-applied");
      const directories: unknown = JSON.parse(environment.stdout.toString("utf8"));
      if (!Array.isArray(directories) || !directories.every((item) => typeof item === "string"))
        throw new TypeError("Invalid rustfmt configuration environment");
      return {
        file: path.posix.join(
          await owner.backend.realpath(path.posix.dirname(owner.location.path)),
          path.posix.basename(owner.location.path),
        ),
        access: {
          paths: path.posix,
          userConfigDirectories: directories
            .filter(Boolean)
            .map((item: string) => remoteLocation(owner.location.target, item, os).path),
          async readText(file: string) {
            try {
              return (await owner.backend.read(file)).bytes.toString("utf8");
            } catch (error) {
              if (
                error instanceof SshBackendError &&
                ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)
              )
                return undefined;
              throw error;
            }
          },
          run: (config, input) =>
            runConfiguredProcess(config, { projectRoot, filePath: source, processAccess, input }),
        },
      };
    },
    async run(config, projectRoot, source, stdin) {
      const owner = registry.resolve(source);
      if (!owner) {
        if (source.includes("://") || projectRoot.includes("://"))
          throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        return runConfiguredFormatter(config, { projectRoot, filePath: source, stdin });
      }
      const before = await owner.backend.read(owner.location.path);
      const result = await runConfiguredProcess(config.run, {
        projectRoot,
        filePath: source,
        processAccess,
        input: stdin ? before.bytes.toString("utf8") : undefined,
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
