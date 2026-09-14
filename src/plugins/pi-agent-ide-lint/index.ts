import {
  configuredExecutableName,
  resolveExternalToolProjectRoot,
} from "pi-agent-ide/api/tool-config";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import type { IdeTool } from "pi-agent-ide/api/toolchain";
import path from "node:path";
import { LINTER_RECIPES } from "./src/catalog.js";
import { createCommandLinter, runConfiguredLinter } from "./src/command-linter.js";
import { lintDoctorPlugin } from "./src/doctor-plugin.js";
import { LintCommandRegistry } from "./src/registry.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerLint(pi: ExtensionAPI): Promise<void> {
  const registries = new Map<string, Promise<LintCommandRegistry>>();
  const registryFor = (cwd: string, external = false): Promise<LintCommandRegistry> => {
    const key = JSON.stringify([cwd, external]);
    let registry = registries.get(key);
    if (registry === undefined) {
      registry = loadRegistry(cwd, external);
      registries.set(key, registry);
    }
    return registry;
  };
  const resolveProject = async (filePath: string, cwd: string) => {
    const projectRoot = await resolveExternalToolProjectRoot(
      cwd,
      filePath,
      "linters",
      LINTER_RECIPES,
    );
    return projectRoot === undefined
      ? undefined
      : { projectRoot, external: projectRoot !== path.resolve(cwd) };
  };

  const linter = {
    kind: "linter",
    name: "pi-agent-ide-lint",
    priority: 200,
    extensions: ["*"],
    detect: async (context) => {
      await registryFor(context.cwd);
      return true;
    },
    async lint(input, context) {
      const project = await resolveProject(input.filePath, context.cwd);
      if (project === undefined) return { ok: true, diagnostics: [] };
      const readyRegistry = await registryFor(project.projectRoot, project.external);
      return createCommandLinter(readyRegistry).lint(input, { cwd: project.projectRoot });
    },
  } satisfies IdeTool;
  const idePlugin = {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "lint",
    setup(api): void {
      api.addTool(linter);

      api.addDiagnosticSource({
        id: "lint",
        async diagnose(filePath, context) {
          const project = await resolveProject(filePath, context.cwd);
          if (project === undefined)
            return {
              status: "unavailable",
              diagnostics: [],
              reason: "No local linter project found for this file",
            };
          const registry = await registryFor(project.projectRoot, project.external);
          context.signal.throwIfAborted();
          const config = registry.resolve(filePath, project.projectRoot);
          if (!config)
            return {
              status: "unavailable",
              diagnostics: [],
              reason: "No linter configured for this file",
            };
          const source = configuredExecutableName(config.check.command);
          const result = await runConfiguredLinter(config, {
            projectRoot: project.projectRoot,
            filePath,
            signal: context.signal,
          });
          return !result.ok && result.diagnostics.length === 0
            ? {
                status: "unavailable",
                diagnostics: [],
                reason: result.failure ?? "Lint check failed",
                source,
              }
            : { status: "ready", diagnostics: result.diagnostics, source };
        },
      });
    },
  } satisfies IdePlugin;

  await Promise.all([connectIdePlugin(pi, idePlugin), connectDoctorPlugin(pi, lintDoctorPlugin)]);
}

async function loadRegistry(cwd: string, external: boolean): Promise<LintCommandRegistry> {
  const configDirectory = external ? cwd : (process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd);
  return LintCommandRegistry.fromDirectory(configDirectory, {
    includeGlobal: !external,
    requireBuiltInEvidence: external,
  });
}
