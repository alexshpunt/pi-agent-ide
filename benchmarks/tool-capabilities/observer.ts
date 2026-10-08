import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Capture the actual runtime model and callable tools without changing their behavior. */
export default function observeCapabilities(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, context) => {
    writeFileSync(
      "/state/runtime.json",
      JSON.stringify(
        {
          model: context.model ? `${context.model.provider}/${context.model.id}` : null,
          thinking: pi.getThinkingLevel(),
          tools: pi.getAllTools().map((tool) => ({
            name: tool.name,
            exposure: tool.exposure,
            namespace: tool.namespace?.name,
          })),
          systemPrompt: event.systemPrompt,
        },
        null,
        2,
      ),
    );
  });
}
