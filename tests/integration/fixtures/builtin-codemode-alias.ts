import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Model local aliases whose streamed names are normalized only after the assistant finishes. */
export default function builtinCodemodeAlias(pi: ExtensionAPI): void {
  const local = "mcp__fixture__codemode";
  pi.on("session_start", (_event, context) => {
    // The harness expands tools by default; preference visibility is a collapsed-state contract.
    context.ui.setToolsExpanded(false);
    const source = pi.getAllTools().find((tool) => tool.name === "codemode");
    if (!source) throw new Error("The builtin Codemode tool is required");
    pi.registerTool({
      name: local,
      label: "Local Codemode alias",
      description: source.description,
      parameters: source.parameters,
      renderCall: () => new Text("LOCAL_CODEMODE_ALIAS_RENDERER", 0, 0),
      renderResult: () => new Text("LOCAL_CODEMODE_ALIAS_RENDERER", 0, 0),
      async execute() {
        throw new Error("Normalized local aliases must execute canonical Codemode");
      },
    });
    for (const kind of ["foreign", "nonmatching"] as const) {
      const marker = `${kind.toUpperCase()}_CODEMODE_RENDERER`;
      pi.registerTool({
        name: `mcp__${kind}__codemode`,
        label: `${kind} Codemode`,
        description: kind === "foreign" ? source.description : "A different script transport",
        parameters: source.parameters,
        ...(kind === "foreign" && {
          namespace: { name: "mcp__foreign", description: "An unrelated MCP server" },
        }),
        renderCall: () => new Text(marker, 0, 0),
        renderResult: () => new Text(marker, 0, 0),
        async execute() {
          return { content: [{ type: "text", text: marker }], details: undefined };
        },
      });
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    for (const block of event.message.content)
      if (block.type === "toolCall" && block.name === local) block.name = "codemode";
  });
  pi.on("tool_execution_start", async (event, context) => {
    await appendFile(
      path.join(context.cwd, "alias-executions.jsonl"),
      JSON.stringify({
        name: event.toolName,
        id: event.toolCallId,
        parent: event.parentToolCallId,
      }) + "\n",
    );
  });
}
