import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { probeSystemBrowser, resolveSystemBrowserExecutable } from "./browser-loader.ts";

import type {
  DoctorPlugin,
  DoctorSetupAction,
  DoctorWorkspace,
} from "pi-agent-doctor/api/plugin-protocol";

/** Runtime dependency check for rendered browser reads. */
export const webDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "web-browser",
  setup(api): void {
    api.addCheck({
      id: "system-browser",
      title: "Browser web reads",
      async run({ env, signal, workspace }) {
        signal?.throwIfAborted();
        if (workspace && !workspace.probeBrowser) {
          return [
            {
              status: "warn",
              message: "Browser reads are unavailable",
              detail: "Project owner does not provide a browser probe",
            },
          ];
        }

        let executablePath: string | undefined;
        try {
          if (workspace?.probeBrowser) {
            const result = await workspace.probeBrowser(signal);
            signal?.throwIfAborted();
            return [
              result.ok
                ? { status: "pass", message: "Chrome/Chromium is available", detail: result.detail }
                : {
                    status: "warn",
                    message: "Browser reads are unavailable",
                    detail: result.detail,
                    setupAction: browserSetupAction(workspace),
                  },
            ];
          }
          executablePath = await resolveSystemBrowserExecutable(
            env.PI_AGENT_IDE_BROWSER_PATH ?? "",
            env,
          );
          await probeSystemBrowser(executablePath, signal);
          signal?.throwIfAborted();
          return [
            {
              status: "pass",
              message: "Chrome/Chromium opened a headless page",
              detail: executablePath,
            },
          ];
        } catch (error) {
          signal?.throwIfAborted();
          return [
            {
              status: "warn",
              message: "Browser reads are unavailable",
              detail:
                executablePath === undefined
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : `Could not open a headless page with ${executablePath}`,
              setupAction: browserSetupAction(workspace),
            },
          ];
        }
      },
    });
  },
};

function browserSetupAction(workspace: DoctorWorkspace | undefined): DoctorSetupAction {
  return {
    id: "browser-unavailable",
    message:
      "Set up Chrome or Chromium for rendered web reads. Direct HTTP(S) reads do not need a browser.",
    agentInstructions: [
      "Ask for explicit approval before installing any browser or system dependency, or persisting configuration. Accepting Doctor delegation or passing --agent is not approval. If the user declines, leave the environment unchanged.",
      workspace
        ? "Inspect and configure only the selected project owner. Reuse the target worker's playwright-core if available; check PI_AGENT_IDE_PLAYWRIGHT_PATH if set. Keep the controller browser and environment unchanged."
        : "Inspect and configure the OS that runs Pi, not the desktop host of a WSL or remote Pi. Use the playwright-core dependency resolved from the installed Pi Agent IDE package.",
      "Look for an existing system Chrome or Chromium or a full Playwright Chromium first. If none works, propose a supported installer for that OS. For Playwright-managed Chromium, use the resolved playwright-core package's cli.js with `install --no-shell chromium` and get the actual executable path from that package's chromium.executablePath(). Do not install system libraries or use elevated privileges without separate approval.",
      workspace
        ? "After approval, persist the absolute executable path in PI_AGENT_IDE_BROWSER_PATH where the target worker's non-interactive SSH environment will inherit it. Rerun /agent-ide-doctor with the same SSH project source."
        : "After approval, persist the absolute executable path in PI_AGENT_IDE_BROWSER_PATH in the user's shell or launcher environment for Pi, not in the project. Verify it from a newly launched Pi with /agent-ide-doctor. The current Pi process cannot inherit this change; tell the user to relaunch if only the fresh check passes.",
      "Report the headless check's actual result. On failure, report what still blocks browser reads and keep direct HTTP(S) reads as the fallback.",
    ].join("\n"),
  };
}
