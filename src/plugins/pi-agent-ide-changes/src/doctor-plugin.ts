import {
  projectExecutableAvailable,
  probeProjectExecutable,
  projectFileExists,
} from "pi-agent-doctor/api/project-probes";
import path from "node:path";
import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/** Git runtime dependency check owned by the changes plugin. */
export const changesDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "changes",
  setup(api): void {
    api.addSetupCheck({
      id: "git",
      async inspect(context) {
        if (
          !(await projectFileExists(
            context,
            context.workspace ? `${context.cwd}/.git` : path.join(context.cwd, ".git"),
          ))
        ) {
          return {};
        }
        return (await projectExecutableAvailable(context, "git"))
          ? {}
          : {
              actions: [
                {
                  id: "git-unavailable",
                  message: "Git integration is unavailable because Git was not found",
                },
              ],
            };
      },
    });

    api.addCheck({
      id: "git",
      title: "Git changes",
      async run(context) {
        const result = await probeProjectExecutable(context, "git", ["--version"]);
        return [
          result.ok
            ? { status: "pass", message: "Git is available", detail: result.detail }
            : {
                status: "warn",
                message: "Git is not available; change anchors and index tools are disabled",
                detail: result.detail,
              },
        ];
      },
    });
  },
};
