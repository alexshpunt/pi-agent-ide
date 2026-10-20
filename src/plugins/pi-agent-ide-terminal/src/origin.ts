import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalExecutionOrigin } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

/** Capture native ancestry before a terminal defers work beyond its tool execution. */
export function registerTerminalOrigins(
  pi: Pick<ExtensionAPI, "on">,
): (toolCallId: string, context: ExtensionContext) => TerminalExecutionOrigin {
  const roots = new Map<string, string>();
  pi.on("tool_call", (event) => {
    const parent = event.parentToolCallId;
    roots.set(
      event.toolCallId,
      parent === undefined ? event.toolCallId : (roots.get(parent) ?? parent),
    );
  });
  pi.on("tool_result", (event) => {
    roots.delete(event.toolCallId);
  });
  pi.on("agent_end", () => {
    roots.clear();
  });
  pi.on("session_shutdown", () => {
    roots.clear();
  });
  return (toolCallId, context) => ({
    toolCallId,
    parentToolCallId: roots.get(toolCallId) ?? toolCallId,
    sessionId: context.sessionManager.getSessionId(),
  });
}
