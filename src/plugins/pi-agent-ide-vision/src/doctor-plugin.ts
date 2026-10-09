import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/** Native graphics readiness only. This does not grant capture or read any pixels. */
export const visionDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "vision",
  setup(api) {
    api.addCheck({
      id: "target-graphics",
      title: "Target screen capture readiness",
      async run(context) {
        // Local capture has its own platform backend; never substitute it for a target probe.
        if (!context.workspace) return [];
        try {
          context.signal?.throwIfAborted();
          if (!context.workspace.probeCapture)
            throw new Error("Project owner does not provide a capture readiness probe");
          const result = await context.workspace.probeCapture(context.signal);
          context.signal?.throwIfAborted();
          return [
            {
              status: result.display.ok ? "pass" : "warn",
              message: "Native display connection",
              detail: result.display.detail,
            },
            {
              status: result.window.ok ? "pass" : "warn",
              message: "Trusted native window identity",
              detail: result.window.detail,
            },
          ];
        } catch (error) {
          context.signal?.throwIfAborted();
          return [
            {
              status: "warn",
              message: "Native capture readiness is unavailable",
              detail: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      },
    });
  },
};
