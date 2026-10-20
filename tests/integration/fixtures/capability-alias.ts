import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A transparent local alias exercises the same nested dispatch as subscription connectors. */
export default function capabilityAlias(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const source = pi.getAllTools().find((tool) => tool.name === "read");
    if (!source) throw new Error("The IDE Read tool is required");
    pi.registerTool({
      name: "mcp__fixture__read",
      label: "Read alias",
      description: source.description,
      parameters: source.parameters,
      async execute(_id, args, signal, onUpdate, ctx) {
        const { result, isError } = await ctx.executeTool("read", args, { signal, onUpdate });
        const { usage: _usage, ...own } = result;
        return isError ? { ...own, isError: true } : own;
      },
    });
  });
}
