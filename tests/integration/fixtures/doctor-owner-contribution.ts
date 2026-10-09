import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

/** A trusted fixture contribution for the public Doctor project's config publication path. */
export default async function registerOwnedDoctorRecipe(pi: ExtensionAPI): Promise<void> {
  await connectDoctorPlugin(pi, {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
    id: "owned-recipe",
    setup(api) {
      api.addLanguage({ id: "owned", name: "Owned fixture", extensions: [".owned"] });
      api.addToolRecipe({
        id: "owned",
        name: "Owned formatter",
        kind: "formatter",
        languages: ["owned"],
        executables: ["owned-doctor"],
        documentation: "https://example.com/owned",
        formatter: {
          extensions: [".owned"],
          run: { command: ["owned-doctor", "format", "{file}"] },
          output: "in-place",
        },
      });
    },
  });
}
