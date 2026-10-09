import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import {
  doctorRuntimeOptions,
  doctorExecutableAvailable,
  withDoctorProbeCopy,
} from "pi-agent-ide/api/doctor";
import { runConfiguredFormatter } from "pi-agent-ide/api/tool-config";

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
          const registry = await FormatterCommandRegistry.fromDirectory(
            context.cwd,
            doctorRuntimeOptions(context),
          );
          const applicable = applicableFormatters(registry, context.files, context.cwd);

          if (applicable.length === 0) {
            return [
              { status: "skip", message: "No formatter matches the inspected project files" },
            ];
          }

          return await Promise.all(
            applicable.map(async ({ entry, source }): Promise<DoctorFinding> => {
              const label = `${entry.id} [${entry.layer}] command ${JSON.stringify(entry.config.run.command)}`;
              return withDoctorProbeCopy(context, source, async (probe) => {
                try {
                  const result = context.workspace
                    ? await context.workspace.run(entry.config.run, probe, context.signal)
                    : await runConfiguredFormatter(entry.config, {
                        projectRoot: context.cwd,
                        filePath: probe,
                        env: context.env,
                      });
                  context.signal?.throwIfAborted();
                  return result.ok
                    ? {
                        status: "pass",
                        message: `${label}: probe passed`,
                        detail: entry.sourcePath,
                      }
                    : {
                        status: "fail",
                        message: `${label}: probe failed`,
                        detail: entry.sourcePath,
                      };
                } catch (error) {
                  context.signal?.throwIfAborted();
                  return {
                    status: "fail",
                    message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
                    detail: entry.sourcePath,
                  };
                }
              });
            }),
          );
        } catch (error) {
          context.signal?.throwIfAborted();
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
    const registry = await FormatterCommandRegistry.fromDirectory(
      context.cwd,
      doctorRuntimeOptions(context),
    );
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
      if (!(await doctorExecutableAvailable(context, selected.config.run))) {
        actions.set(selected.id, {
          id: `formatter-${selected.id}-unavailable`,
          message: `Configured formatter ${selected.id} cannot run ${JSON.stringify(selected.config.run.command)}`,
        });
      }
    }

    return { selections, actions: [...actions.values()] };
  } catch (error) {
    context.signal?.throwIfAborted();
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
