import { writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Capture the final prompt and configured tool metadata from a real Pi turn. */
export default function captureAgentInterface(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const output = process.env.PI_AGENT_INTERFACE_CAPTURE;
    if (output === undefined) {
      throw new Error("PI_AGENT_INTERFACE_CAPTURE is required");
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          systemPrompt: event.systemPrompt,
          activeTools: pi.getActiveTools(),
          tools: pi.getAllTools(),
        },
        null,
        2,
      ),
      "utf8",
    );
  });
}
