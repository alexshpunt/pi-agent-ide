import { probeExecutable } from "pi-agent-doctor/api/executable";
import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { resolveRipgrepExecutable } from "#src/ripgrep.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/** Runtime dependency checks owned by local text search. */
export const textSearchDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "search-text",
  setup(api): void {
    api.addCheck({
      id: "ripgrep",
      title: "Local search",
      async run(context) {
        const agentDirectory = context.env.PI_CODING_AGENT_DIR;
        const executable = resolveRipgrepExecutable(agentDirectory);
        const result = await probeExecutable(executable, ["--version"], context.cwd, context.env);
        return [
          result.ok
            ? { status: "pass", message: "ripgrep is available", detail: result.detail }
            : { status: "fail", message: "ripgrep is not available", detail: result.detail },
        ];
      },
    });
  },
};
