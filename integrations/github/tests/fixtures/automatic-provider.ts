import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import provider from "./provider.ts";

export default async function automaticProvider(pi: ExtensionAPI): Promise<void> {
  await provider(pi);
  pi.registerTool({
    name: "mode_probe",
    label: "Mode probe",
    description: "Test-only view of the visible GitHub resource tool family.",
    parameters: Type.Object({}),
    async execute() {
      const visible = pi.getAllTools()
        .filter(tool => tool.name.startsWith("github_") && tool.exposure !== "hidden")
        .map(tool => tool.name).sort();
      const active = pi.getActiveTools().filter(name => name.startsWith("github_"));
      return { content: [{ type: "text", text: JSON.stringify({ visible, active }) }], details: { visible, active } };
    },
  });
}
