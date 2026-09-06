import path from "node:path";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { URI } from "vscode-uri";

import { hasConfiguredExecutable } from "pi-agent-ide/api/tool-config";

import { LSP_RECIPES } from "./catalog.js";
import { LspClient } from "./lsp/client.js";
import { LspServerRegistry } from "./lsp/registry.js";

import type {
  DoctorContext,
  DoctorFinding,
  DoctorPlugin,
  DoctorSetupInspection,
} from "pi-agent-doctor/api/plugin-protocol";
import type { ResolvedServer } from "./lsp/types.js";

/**
Doctor contribution owned by the LSP plugin.
*/
export const lspDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "lsp",
  setup(api): void {
    for (const recipe of LSP_RECIPES) {
      api.addToolRecipe(recipe);
    }

    api.addSetupCheck({
      id: "effective-config",
      inspect: inspectLspSetup,
    });

    api.addCheck({
      id: "config",
      title: "LSP",
      async run(context) {
        try {
          const registry = await LspServerRegistry.fromPackageDir(context.cwd, {
            environment: context.env,
          });
          const applicable = applicableServers(registry, context.files);

          if (applicable.length === 0) {
            return [
              { status: "skip", message: "No language server matches the inspected project files" },
            ];
          }

          return await Promise.all(
            applicable.map(async (server): Promise<DoctorFinding> => {
              const label = `${server.serverId} [${server.layer}] command ${JSON.stringify(server.config.command)}`;
              const client = new LspClient({
                serverId: server.serverId,
                rootUri: URI.file(context.cwd).toString(),
                command: server.config.command,
                env: definedEnvironment(context.env, server.config.env),
                ...(server.config.initializationOptions && {
                  initOptions: server.config.initializationOptions,
                }),
                ...(server.config.settings && { settings: server.config.settings }),
                ...(server.config.timeoutMs && { timeoutMs: server.config.timeoutMs }),
              });

              try {
                await client.start();
                return {
                  status: "pass",
                  message: `${label}: initialized`,
                  detail: server.sourcePath,
                };
              } catch (error) {
                return {
                  status: "fail",
                  message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
                  detail: server.sourcePath,
                };
              } finally {
                await client.shutdown().catch(() => {});
              }
            }),
          );
        } catch (error) {
          return [
            {
              status: "fail",
              message: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      },
    });
  },
};

async function inspectLspSetup(context: DoctorContext): Promise<DoctorSetupInspection> {
  try {
    const registry = await LspServerRegistry.fromPackageDir(context.cwd, {
      environment: context.env,
    });
    const selections = [];
    const actions = new Map<string, { readonly id: string; readonly message: string }>();

    for (const [languageId, files] of context.detectedLanguages) {
      const selected = files
        .flatMap((file) => registry.resolve(path.extname(file)))
        .find((server) => server.languageId === languageId);
      if (selected === undefined) {
        continue;
      }

      selections.push({ kind: "lsp" as const, languageId, toolId: selected.serverId });
      if (!(await hasConfiguredExecutable(selected.config, context.cwd, context.env))) {
        actions.set(selected.serverId, {
          id: `lsp-${selected.serverId}-unavailable`,
          message: `Configured language server ${selected.serverId} cannot run ${JSON.stringify(selected.config.command)}`,
        });
      }
    }

    return { selections, actions: [...actions.values()] };
  } catch (error) {
    return {
      actions: [
        {
          id: "lsp-config-invalid",
          message: `Language server configuration cannot load: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function applicableServers(
  registry: LspServerRegistry,
  files: readonly string[],
): readonly ResolvedServer[] {
  const applicable = new Map<string, ResolvedServer>();

  for (const file of files) {
    const server = registry.resolve(path.extname(file))[0];

    if (server !== undefined && !applicable.has(server.serverId)) {
      applicable.set(server.serverId, server);
    }
  }

  return [...applicable.values()];
}

function definedEnvironment(
  base: NodeJS.ProcessEnv,
  override: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...base, ...override }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
