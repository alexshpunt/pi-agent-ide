import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { hasConfiguredExecutable, runConfiguredFormatter } from "pi-agent-ide/api/tool-config";

import { FORMATTER_RECIPES } from "./catalog.js";
import { FormatterCommandRegistry } from "./registry.js";

import type {
  DoctorContext,
  DoctorFinding,
  DoctorPlugin,
  DoctorSetupInspection,
} from "pi-agent-doctor/api/plugin-protocol";
import type {
  EffectiveToolConfigEntry,
  FormatterCommandConfig,
} from "pi-agent-ide/api/tool-config";

/**
Doctor contribution owned by the formatter plugin.
*/
export const formatterDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "formatter",
  setup(api): void {
    for (const recipe of FORMATTER_RECIPES) {
      api.addToolRecipe(recipe);
    }

    api.addSetupCheck({
      id: "effective-config",
      inspect: inspectFormatterSetup,
    });

    api.addCheck({
      id: "config",
      title: "Formatter",
      async run(context) {
        try {
          const registry = await FormatterCommandRegistry.fromDirectory(context.cwd, {
            environment: context.env,
          });
          const applicable = applicableFormatters(registry, context.files, context.cwd);

          if (applicable.length === 0) {
            return [
              { status: "skip", message: "No formatter matches the inspected project files" },
            ];
          }

          return await Promise.all(
            applicable.map(async ({ entry, source }): Promise<DoctorFinding> => {
              const label = `${entry.id} [${entry.layer}] command ${JSON.stringify(entry.config.run.command)}`;
              const directory = await mkdtemp(
                path.join(path.dirname(source), ".pi-agent-ide-doctor-"),
              );
              const probe = path.join(directory, path.basename(source));

              try {
                await copyFile(source, probe);
                const result = await runConfiguredFormatter(entry.config, {
                  projectRoot: context.cwd,
                  filePath: probe,
                  env: context.env,
                });
                return result.ok
                  ? { status: "pass", message: `${label}: probe passed`, detail: entry.sourcePath }
                  : { status: "fail", message: `${label}: probe failed`, detail: entry.sourcePath };
              } catch (error) {
                return {
                  status: "fail",
                  message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
                  detail: entry.sourcePath,
                };
              } finally {
                await rm(directory, { recursive: true, force: true });
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

async function inspectFormatterSetup(context: DoctorContext): Promise<DoctorSetupInspection> {
  try {
    const registry = await FormatterCommandRegistry.fromDirectory(context.cwd, {
      environment: context.env,
    });
    const selections = [];
    const actions = new Map<string, { readonly id: string; readonly message: string }>();

    for (const [languageId, files] of context.detectedLanguages) {
      const selected = files
        .map((file) => registry.resolveEntry(file, context.cwd))
        .find((entry) => entry !== undefined);
      if (selected === undefined) {
        continue;
      }

      selections.push({ kind: "formatter" as const, languageId, toolId: selected.id });
      if (!(await hasConfiguredExecutable(selected.config.run, context.cwd, context.env))) {
        actions.set(selected.id, {
          id: `formatter-${selected.id}-unavailable`,
          message: `Configured formatter ${selected.id} cannot run ${JSON.stringify(selected.config.run.command)}`,
        });
      }
    }

    return { selections, actions: [...actions.values()] };
  } catch (error) {
    return {
      actions: [
        {
          id: "formatter-config-invalid",
          message: `Formatter configuration cannot load: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function applicableFormatters(
  registry: FormatterCommandRegistry,
  files: readonly string[],
  projectRoot: string,
): readonly {
  readonly entry: EffectiveToolConfigEntry<FormatterCommandConfig>;
  readonly source: string;
}[] {
  const applicable = new Map<
    string,
    { entry: EffectiveToolConfigEntry<FormatterCommandConfig>; source: string }
  >();

  for (const source of files) {
    const entry = registry.resolveEntry(source, projectRoot);

    if (entry !== undefined && !applicable.has(entry.id)) {
      applicable.set(entry.id, { entry, source });
    }
  }

  return [...applicable.values()];
}
