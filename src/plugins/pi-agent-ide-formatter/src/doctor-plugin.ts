import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import {
  parseFormattersConfig,
  projectIdeConfigPath,
  runConfiguredFormatter,
} from "pi-agent-ide/api/tool-config";

import { FORMATTER_RECIPES } from "./catalog.js";

import type { DoctorFinding, DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

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

    api.addCheck({
      id: "config",
      title: "Formatter",
      async run(context) {
        const file = projectIdeConfigPath(context.cwd, "formatters");

        try {
          const config = parseFormattersConfig(JSON.parse(await readFile(file, "utf8")));
          const findings: DoctorFinding[] = [
            {
              status: "pass",
              message: `${Object.keys(config.formatters).length} formatter mappings loaded`,
              detail: file,
            },
          ];

          for (const [id, formatter] of Object.entries(config.formatters)) {
            const source = context.files.find((candidate) =>
              formatter.extensions.includes(path.extname(candidate).toLowerCase()),
            );

            if (source === undefined) {
              continue;
            }

            const directory = await mkdtemp(
              path.join(path.dirname(source), ".pi-agent-ide-doctor-"),
            );
            const probe = path.join(directory, path.basename(source));

            try {
              await copyFile(source, probe);
              const result = await runConfiguredFormatter(formatter, {
                projectRoot: context.cwd,
                filePath: probe,
                env: context.env,
              });
              findings.push(
                result.ok
                  ? { status: "pass", message: `${id} probe passed`, detail: path.basename(source) }
                  : {
                      status: "fail",
                      message: `${id} probe failed`,
                      detail: path.basename(source),
                    },
              );
            } catch (error) {
              findings.push({
                status: "fail",
                message: `${id}: ${error instanceof Error ? error.message : String(error)}`,
              });
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          }

          return findings;
        } catch (error) {
          if (isMissing(error)) {
            return [{ status: "warn", message: "Formatter config is not created", detail: file }];
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
