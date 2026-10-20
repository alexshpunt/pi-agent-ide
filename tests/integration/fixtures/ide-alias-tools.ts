import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Reproduce local subscription aliases without credentials or a provider request. */
export default function ideAliasTools(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    for (const name of ["read", "search", "replace", "write"]) {
      const source = pi.getAllTools().find((tool) => tool.name === name);
      if (!source) throw new Error(`Missing source tool: ${name}`);
      pi.registerTool({
        name: `mcp__fixture__${name}`,
        label: `MCP ${name}`,
        description: source.description,
        parameters: source.parameters,
        renderCall: () => new Text("GENERIC_ALIAS_CALL", 0, 0),
        renderResult: () => new Text("GENERIC_ALIAS_RESULT", 0, 0),
        async execute(_id, args, signal, onUpdate, ctx) {
          const { result, isError } = await ctx.executeTool(name, args, { signal, onUpdate });
          const { usage: _nestedUsage, ...own } = result;
          return { ...own, isError };
        },
      });
    }
    const read = pi.getAllTools().find((tool) => tool.name === "read");
    if (!read) throw new Error("Missing source read");
    pi.registerTool({
      name: "mcp__foreign__read",
      label: "Foreign read",
      namespace: { name: "mcp__foreign", description: "An unrelated MCP server." },
      description: read.description,
      parameters: read.parameters,
      renderCall: () => new Text("FOREIGN_MCP_CALL", 0, 0),
      renderResult: () => new Text("FOREIGN_MCP_RESULT", 0, 0),
      async execute() {
        return { content: [{ type: "text", text: "FOREIGN_RESULT" }], details: undefined };
      },
    });
  });
}
