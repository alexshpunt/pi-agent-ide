import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Inspect the provider transport contract, not the wording of any agent instruction. */
export default function portableContextProbe(pi: ExtensionAPI): void {
  let observed: { opaque: boolean; fixture: string | undefined } | undefined;
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.transport_fixture = "transport-fixture-value";
    observed = {
      opaque: event.systemPromptOptions.forceSystemPrompt !== undefined,
      fixture: event.systemPromptOptions.sections.transport_fixture,
    };
  });
  pi.registerTool({
    name: "portable_context_probe",
    label: "Portable context probe",
    description: "Inspect whether the current provider context is structured or opaque.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: JSON.stringify(observed) }],
        details: undefined,
      };
    },
  });
}
