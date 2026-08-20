import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import {
  parseLintersConfig,
  projectIdeConfigPath,
  runConfiguredProcess,
} from "pi-agent-ide/api/tool-config";

import { LINTER_RECIPES } from "./catalog.js";

import type { DoctorFinding, DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/**
Doctor contribution owned by the lint plugin.
*/
export const lintDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "lint",
  setup(api): void {
    for (const recipe of LINTER_RECIPES) {
      api.addToolRecipe(recipe);
    }

    api.addCheck({
      id: "config",
      title: "Linter",
      async run(context) {
        const file = projectIdeConfigPath(context.cwd, "linters");

        try {
          const config = parseLintersConfig(JSON.parse(await readFile(file, "utf8")));
          const findings: DoctorFinding[] = [
            {
              status: "pass",
              message: `${Object.keys(config.linters).length} linter mappings loaded`,
              detail: file,
            },
          ];

          for (const [id, linter] of Object.entries(config.linters)) {
            const source = context.files.find((candidate) =>
              linter.extensions.includes(path.extname(candidate).toLowerCase()),
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
              const result = await runConfiguredProcess(linter.check, {
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
                      detail: result.stderr.trim().slice(0, 200),
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
            return [{ status: "warn", message: "Linter config is not created", detail: file }];
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
