import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Track the running calls of `toolName` that a script, such as Codemode, makes rather than the
 * model: Pi reports them with a parent tool call. The returned check tells whether a call id
 * belongs to one, so the tool can hand the script its whole result as the `script` audience.
 */
export function trackScriptCalls(
  pi: ExtensionAPI,
  toolName: string,
): (toolCallId: string) => boolean {
  const calls = new Set<string>();
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === toolName && event.parentToolCallId !== undefined)
      calls.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    calls.delete(event.toolCallId);
  });
  return (toolCallId) => calls.has(toolCallId);
}
