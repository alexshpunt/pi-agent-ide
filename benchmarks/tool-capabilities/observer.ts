import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registeredAliasRoutes } from "./validation.ts";
import { guardTuiHistory, mirrorTuiEvents } from "./tui.ts";

/** Capture final loadout after every before-agent hook, without changing execution. */
export default function observeCapabilities(pi: ExtensionAPI): void {
  if (process.env.CAPABILITY_TUI_HISTORY === "restore") {
    guardTuiHistory(pi, "/state/history-events.jsonl");
    return;
  }
  if (process.env.CAPABILITY_TUI === "1") mirrorTuiEvents(pi, "/state/events.jsonl");
  pi.on("agent_start", (_event, context) => {
    const tools = pi.getAllTools();
    writeFileSync(
      "/state/runtime.json",
      JSON.stringify(
        {
          model: context.model ? `${context.model.provider}/${context.model.id}` : null,
          thinking: pi.getThinkingLevel(),
          processIdentity: { uid: process.getuid?.(), gid: process.getgid?.() },
          tools: tools.map((tool) => ({
            name: tool.name,
            exposure: tool.exposure,
            namespace: tool.namespace?.name,
            parameters: tool.parameters,
            sourceInfo: tool.sourceInfo,
          })),
          aliases:
            process.env.CAPABILITY_CONNECTOR_ALIASES === "1"
              ? registeredAliasRoutes(tools, process.env.CAPABILITY_CONNECTOR_PACKAGE ?? "")
              : {},
          systemPrompt: context.getSystemPrompt(),
        },
        null,
        2,
      ),
    );
  });
}
