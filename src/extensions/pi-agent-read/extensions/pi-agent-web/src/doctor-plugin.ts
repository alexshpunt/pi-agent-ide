import { probeExecutable } from "pi-agent-doctor/api/executable";
import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { resolveSystemBrowserExecutable } from "./browser-loader.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/** Runtime dependency check for rendered browser reads. */
export const webDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "web-browser",
  setup(api): void {
    api.addCheck({
      id: "system-browser",
      title: "Browser web reads",
      async run(context) {
        try {
          const executable = await resolveSystemBrowserExecutable(
            context.env.PI_AGENT_IDE_BROWSER_PATH,
            context.env,
          );
          const result = await probeExecutable(executable, ["--version"], context.cwd, context.env);
          return [
            result.ok
              ? { status: "pass", message: "Chrome/Chromium is available", detail: result.detail }
              : { status: "warn", message: "Chrome/Chromium cannot start", detail: result.detail },
          ];
        } catch (error) {
          return [
            {
              status: "warn",
              message: "Browser reads are unavailable",
              detail: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      },
    });
  },
};
