import { isDeepStrictEqual } from "node:util";
import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";

/**
 * Preserve native IDE contracts and presentation for matching local MCP forwarding aliases.
 * Unnamespaced aliases opt into this contract by copying one IDE tool's description and schema.
 * Local wrappers with conflicting behavior must not advertise that same contract.
 * Load IDE before the alias owner: Pi keeps the first extension's executable definition.
 * Builtin Codemode aliases reuse Pi's shipped renderer only; execution and custom renderer overrides
 * are not captured or replaced.
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
        ((definitions.has(tool.name) && tool.namespace?.name.startsWith("ide_") === true) ||
          (tool.name === "codemode" &&
            tool.sourceInfo.source === "builtin" &&
            tool.sourceInfo.path === "builtin:codemode")) &&
        tool.exposure !== "hidden" &&
        tool.description === alias.description &&
        isDeepStrictEqual(tool.parameters, alias.parameters),
    );
    return matches.length === 1 ? matches[0]?.name : undefined;
  };
  let codemodeRenderers: ToolRenderers | undefined;
  pi.registerToolRenderer((name, next) => {
    const native = source(name);
    if (native !== "codemode") return native === undefined ? next() : definitions.get(native);
    if (!codemodeRenderers) {
      // Capture Pi's shipped presentation through its public factory, never its execution/ownership.
      // The factory only registers a definition; none of its executor/settings closures run here.
      void createCodemodeExtension()({
        ...pi,
        registerTool: (definition) => {
          const { renderShell, renderCall, renderResult } = definition as ToolDefinition;
          codemodeRenderers = { renderShell, renderCall, renderResult };
        },
      });
    }
    return codemodeRenderers ?? next();
  });
  pi.on("before_agent_start", () => {
    for (const alias of pi.getAllTools()) {
      const native = source(alias.name);
      const definition = native === undefined ? undefined : definitions.get(native);
      if (!definition) continue;
      const descriptors = Object.getOwnPropertyDescriptors(definition);
      // Preserve live metadata getters and outputSchema without presenting a second IDE contract.
      delete descriptors.namespace;
      descriptors.name = {
        value: alias.name,
        enumerable: true,
        configurable: true,
        writable: true,
      };
      descriptors.exposure = {
        // Deferred aliases remain callable by scripts without duplicating the Codemode catalogue.
        value: alias.exposure === "model-only" ? alias.exposure : "deferred",
        enumerable: true,
        configurable: true,
        writable: true,
      };
      const prepareLoadout: ToolDefinition["prepareLoadout"] = (loadout) => {
        const changes = definition.prepareLoadout?.(loadout);
        if (!loadout.declared.some((tool) => tool.name === definition.name)) return changes;
        // Keep the connector's active route and wire remapping, but declare the source only once.
        return {
          ...changes,
          hiddenDeclarations: [...(changes?.hiddenDeclarations ?? []), alias.name],
        };
      };
      descriptors.prepareLoadout = {
        value: prepareLoadout,
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
