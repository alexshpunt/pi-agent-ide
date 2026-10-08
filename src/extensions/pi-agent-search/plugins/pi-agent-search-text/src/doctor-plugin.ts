import {
  projectExecutableAvailable,
  probeProjectExecutable,
} from "pi-agent-doctor/api/project-probes";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { resolveRipgrepExecutable } from "#src/ripgrep.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/** Runtime dependency checks owned by local text search. */
export const textSearchDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "search-text",
  setup(api): void {
    api.addSetupCheck({
      id: "ripgrep",
      async inspect(context) {
        const executable = context.workspace
          ? "rg"
          : resolveRipgrepExecutable(context.env.PI_CODING_AGENT_DIR);
        const available = await projectExecutableAvailable(context, executable);
        return available
          ? {}
          : {
              actions: [
                {
                  id: "ripgrep-unavailable",
                  message: "Local search is unavailable because ripgrep was not found",
                },
              ],
            };
      },
    });

    api.addCheck({
      id: "ripgrep",
      title: "Local search",
      async run(context) {
        const agentDirectory = context.env.PI_CODING_AGENT_DIR;
        const executable = context.workspace ? "rg" : resolveRipgrepExecutable(agentDirectory);
        const result = await probeProjectExecutable(context, executable, ["--version"]);
        return [
          result.ok
            ? { status: "pass", message: "ripgrep is available", detail: result.detail }
            : { status: "fail", message: "ripgrep is not available", detail: result.detail },
        ];
      },
    });
  },
};
