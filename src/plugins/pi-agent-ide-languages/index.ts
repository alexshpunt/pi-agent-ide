import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { LANGUAGES } from "./src/languages.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/**
Registers language knowledge without depending on formatter, linter, or LSP plugins.
*/
export default function registerLanguages(pi: ExtensionAPI): void | Promise<void> {
  const plugin = {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
    id: "languages",
    setup(api): void {
      for (const language of LANGUAGES) {
        api.addLanguage(language);
      }
    },
  } satisfies DoctorPlugin;
  return connectDoctorPlugin(pi, plugin);
}
