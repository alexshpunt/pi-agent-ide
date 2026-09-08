import { isExecutableAvailable, probeExecutable } from "pi-agent-doctor/api/executable";
import { access } from "node:fs/promises";
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
        if (!(await isGitProject(context.cwd))) {
          return {};
        }
        return (await isExecutableAvailable("git", context.cwd, context.env))
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
        const result = await probeExecutable("git", ["--version"], context.cwd, context.env);
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

async function isGitProject(cwd: string): Promise<boolean> {
  try {
    await access(path.join(cwd, ".git"));
    return true;
  } catch {
    return false;
  }
}
