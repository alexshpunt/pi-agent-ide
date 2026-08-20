import { access } from "node:fs/promises";
import path from "node:path";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { projectIdeConfigPath } from "pi-agent-ide/api/tool-config";
import { URI } from "vscode-uri";

import { LSP_RECIPES } from "./catalog.js";
import { LspClient } from "./lsp/client.js";
import { LspServerRegistry } from "./lsp/registry.js";

import type { DoctorFinding, DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

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

    api.addCheck({
      id: "config",
      title: "LSP",
      async run(context) {
        const file = projectIdeConfigPath(context.cwd, "lsp-servers");

        try {
          await access(file);
          const registry = await LspServerRegistry.fromPackageDir(context.cwd);
          const findings: DoctorFinding[] = [
            {
              status: "pass",
              message: `${Object.keys(registry.servers).length} language servers loaded`,
              detail: file,
            },
          ];

          for (const [id, server] of Object.entries(registry.servers)) {
            if (
              !Object.values(server.languages).some((language) =>
                context.files.some((file) =>
                  language.extensions.includes(path.extname(file).toLowerCase()),
                ),
              )
            ) {
              continue;
            }
            const client = new LspClient({
              serverId: id,
              rootUri: URI.file(context.cwd).toString(),
              command: server.command,
              env: definedEnvironment(context.env, server.env),
              ...(server.initializationOptions && { initOptions: server.initializationOptions }),
              ...(server.settings && { settings: server.settings }),
              ...(server.timeoutMs && { timeoutMs: server.timeoutMs }),
            });

            try {
              await client.start();
              findings.push({ status: "pass", message: `${id} initialized` });
            } catch (error) {
              findings.push({
                status: "fail",
                message: `${id}: ${error instanceof Error ? error.message : String(error)}`,
              });
            } finally {
              await client.shutdown().catch(() => {});
            }
          }

          return findings;
        } catch (error) {
          if (isMissing(error)) {
            return [{ status: "warn", message: "LSP config is not created", detail: file }];
          }

          return [
            {
              status: "fail",
              message: error instanceof Error ? error.message : String(error),
              detail: file,
            },
          ];
        }
      },
    });
  },
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
