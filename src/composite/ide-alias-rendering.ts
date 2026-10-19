import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Preserve native IDE contracts and presentation for matching local MCP forwarding aliases.
 * Unnamespaced aliases opt into this contract by copying one IDE tool's description and schema.
 * Local wrappers with conflicting behavior must not advertise that same contract.
 * Load IDE before the alias owner: Pi keeps the first extension's executable definition.
 */
export function registerIdeAliasCompatibility(
  pi: ExtensionAPI,
  definitions: ReadonlyMap<string, ToolDefinition>,
): (name: string) => string | undefined {
  const source = (name: string): string | undefined => {
    if (!name.startsWith("mcp__")) return undefined;
    const tools = pi.getAllTools();
    const alias = tools.find((tool) => tool.name === name);
    // Real MCP servers own their namespace. A matching suffix alone proves nothing.
    if (!alias || alias.namespace || alias.exposure === "hidden") return undefined;
    const matches = tools.filter(
      (tool) =>
        definitions.has(tool.name) &&
        tool.namespace?.name.startsWith("ide_") === true &&
        tool.exposure !== "hidden" &&
        tool.description === alias.description &&
        isDeepStrictEqual(tool.parameters, alias.parameters),
    );
    return matches.length === 1 ? matches[0]?.name : undefined;
  };
  pi.registerToolRenderer((name, next) => {
    const native = source(name);
    return native === undefined ? next() : definitions.get(native);
  });
  pi.on("before_agent_start", () => {
    for (const alias of pi.getAllTools()) {
      const native = source(alias.name);
      const definition = native === undefined ? undefined : definitions.get(native);
      if (!definition) continue;
      const descriptors = Object.getOwnPropertyDescriptors(definition);
      // Preserve live metadata getters and outputSchema, but keep the alias's exposure and identity.
      delete descriptors.namespace;
      descriptors.name = {
        value: alias.name,
        enumerable: true,
        configurable: true,
        writable: true,
      };
      descriptors.exposure = {
        value: alias.exposure,
        enumerable: true,
        configurable: true,
        writable: true,
      };
      const execute: ToolDefinition["execute"] = async (_id, args, signal, onUpdate, ctx) => {
        const { result, isError } = await ctx.executeTool(definition.name, args, {
          signal,
          onUpdate,
        });
        // Pi already charges nested usage to the parent call.
        const { usage: _nestedUsage, ...own } = result;
        return { ...own, isError };
      };
      descriptors.execute = {
        value: execute,
        enumerable: true,
        configurable: true,
        writable: true,
      };
      const forwarded = Object.defineProperties({}, descriptors) as ToolDefinition;
      // Same-name registration preserves activation; do not enable an inactive source or alias.
      pi.registerTool(forwarded);
    }
  });
  return source;
}
