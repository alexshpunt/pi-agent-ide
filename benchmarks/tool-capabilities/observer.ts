import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registeredAliasRoutes } from "./validation.ts";
import { capabilityCases } from "./cases.ts";
import { capabilityPrompt } from "./prompts.ts";
import { guardTuiHistory, mirrorTuiEvents } from "./tui.ts";

/** Resolve the case prompt against the selected API and capture the final loadout. */
export default function observeCapabilities(pi: ExtensionAPI): void {
  if (process.env.CAPABILITY_TUI_HISTORY === "restore") {
    guardTuiHistory(pi, "/state/history-events.jsonl");
    return;
  }
  if (process.env.CAPABILITY_TUI === "1") mirrorTuiEvents(pi, "/state/events.jsonl");
  pi.on("input", (_event, context) => {
    const task = capabilityCases.find((entry) => entry.id === process.env.CAPABILITY_CASE);
    if (!task) return;
    const api: unknown = context.model?.api;
    const text = capabilityPrompt(
      task,
      process.env.CAPABILITY_MODE ?? "direct",
      typeof api === "string" ? api : undefined,
    );
    writeFileSync("/state/prompt.txt", text);
    return { action: "transform", text };
  });
  pi.on("agent_start", (_event, context) => {
    const tools = pi.getAllTools();
    const api: unknown = context.model?.api;
    writeFileSync(
      "/state/runtime.json",
      JSON.stringify(
        {
          model: context.model ? `${context.model.provider}/${context.model.id}` : null,
          modelApi: typeof api === "string" ? api : null,
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
