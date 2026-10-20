import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Reproduce Connector 1.2.0's Insert alias, including omitted outputSchema, without credentials. */
export default function structuredInsertAlias(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const source = pi.getAllTools().find((tool) => tool.name === "insert");
    if (!source) throw new Error("The IDE Insert tool is required");
    pi.registerTool({
      name: "mcp__agent_ide__insert",
      label: "MCP Insert",
      description: source.description,
      parameters: source.parameters,
      async execute(_id, args, signal, onUpdate, context) {
        const { result, isError } = await context.executeTool("insert", args, { signal, onUpdate });
        const { usage: _nestedUsage, ...own } = result;
        return { ...own, isError };
      },
    });
  });
}
