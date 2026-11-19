import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Record the selected model, thinking level and the tools declared to the model. */
export default function observeByteExactRun(pi: ExtensionAPI): void {
  pi.on("agent_start", (_event, context) => {
    writeFileSync(
      "/state/runtime.json",
      JSON.stringify({
        model: context.model ? `${context.model.provider}/${context.model.id}` : null,
        thinking: pi.getThinkingLevel(),
        activeTools: pi.getActiveTools(),
      }),
    );
  });
}
