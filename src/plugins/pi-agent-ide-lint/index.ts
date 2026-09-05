import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import type { IdeTool } from "pi-agent-ide/api/toolchain";
import { createCommandLinter, runConfiguredLinter } from "./src/command-linter.js";
import { lintDoctorPlugin } from "./src/doctor-plugin.js";
import { LintCommandRegistry } from "./src/registry.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default async function registerLint(pi: ExtensionAPI): Promise<void> {
  let registryCwd: string | undefined;
  let registryReady: Promise<LintCommandRegistry> | undefined;
  const registryFor = (cwd: string): Promise<LintCommandRegistry> => {
    if (registryReady === undefined || registryCwd !== cwd) {
      registryCwd = cwd;
      registryReady = loadRegistry(cwd);
    }

    return registryReady;
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
      const readyRegistry = await registryFor(context.cwd);
      return createCommandLinter(readyRegistry).lint(input, context);
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
          const registry = await registryFor(context.cwd);
          context.signal.throwIfAborted();
          const config = registry.resolve(filePath, context.cwd);
          if (!config)
            return {
              status: "unavailable",
              diagnostics: [],
              reason: "No linter configured for this file",
            };
          const result = await runConfiguredLinter(config, {
            projectRoot: context.cwd,
            filePath,
            signal: context.signal,
          });
          return !result.ok && result.diagnostics.length === 0
            ? {
                status: "unavailable",
                diagnostics: [],
                reason: result.failure ?? "Lint check failed",
              }
            : { status: "ready", diagnostics: result.diagnostics };
        },
      });
    },
  } satisfies IdePlugin;

  await Promise.all([connectIdePlugin(pi, idePlugin), connectDoctorPlugin(pi, lintDoctorPlugin)]);
}

async function loadRegistry(cwd: string): Promise<LintCommandRegistry> {
  const configDirectory = process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd;
  return LintCommandRegistry.fromDirectory(configDirectory);
}
