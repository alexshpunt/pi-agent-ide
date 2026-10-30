import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ToolAvailability {
  hide(): void;
  restore(): void;
}

type AvailabilityApi = Pick<
  ExtensionAPI,
  "registerTool" | "getSettings" | "getAllTools" | "getActiveTools" | "setActiveTools"
>;

function resolveToolSelection(entries: readonly string[]) {
  const excluded = new Set<string>();
  const requested = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("-")) {
      excluded.add(entry.slice(1));
      requested.delete(entry.slice(1));
    } else {
      const name = entry.startsWith("+") ? entry.slice(1) : entry;
      excluded.delete(name);
      requested.add(name);
    }
  }
  return { excluded, requested };
}

/** Keep explicit settings exclusions out of every native IDE execution path. */
export function createIdeToolAvailability<TApi extends AvailabilityApi>(pi: TApi) {
  const definitions = new Map<string, ToolAvailability>();
  const hidden = new Set<string>();
  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    const capabilityLoader = definition.name.startsWith("ide_capability_");
    if (definition.namespace?.name.startsWith("ide_") === true || capabilityLoader) {
      definitions.set(definition.name, {
        hide: () =>
          pi.registerTool({
            ...definition,
            get description() {
              return definition.description;
            },
            get promptGuidelines() {
              return definition.promptGuidelines;
            },
            get parameters() {
              return definition.parameters;
            },
            exposure: "hidden",
          }),
        restore: () => pi.registerTool(definition),
      });
    }
    // Capability loaders register after startup; enforce their settings before exposing them.
    if (capabilityLoader) {
      if (resolveToolSelection(pi.getSettings().defaultTools ?? []).excluded.has(definition.name))
        hidden.add(definition.name);
      else hidden.delete(definition.name);
    }
    if (hidden.has(definition.name)) definitions.get(definition.name)?.hide();
    else pi.registerTool(definition);
  };

  return {
    api: { ...pi, registerTool },
    /**
     * Enforce exclusions. At session startup, also make deferred IDE tools discoverable through
     * tool_search, and activate configured or restored tools unless the host already owns that
     * loadout (`hostLoadout`).
     */
    reconcile(
      activateDefaults = false,
      restoredTools: readonly string[] = [],
      hostLoadout = false,
    ): void {
      const { excluded, requested } = resolveToolSelection(pi.getSettings().defaultTools ?? []);
      for (const [name, definition] of definitions) {
        if (excluded.has(name) === hidden.has(name)) continue;
        if (excluded.has(name)) {
          definition.hide();
          hidden.add(name);
        } else {
          definition.restore();
          hidden.delete(name);
        }
      }
      // The host registry already applies CLI allowlists and exclusions. Never
      // activate a tool absent from it, or infer deferred availability from active tools.
      const available = pi.getAllTools().filter((tool) => tool.exposure !== "hidden");
      const active = new Set(pi.getActiveTools());
      for (const tool of available) {
        if (
          activateDefaults &&
          !hostLoadout &&
          definitions.has(tool.name) &&
          (requested.has(tool.name) ||
            (tool.exposure === "deferred" && restoredTools.includes(tool.name)))
        )
          active.add(tool.name);
      }
      if (
        activateDefaults &&
        !excluded.has("tool_search") &&
        available.some((tool) => tool.name === "tool_search") &&
        available.some((tool) => definitions.has(tool.name) && tool.exposure === "deferred")
      )
        active.add("tool_search");
      const previous = pi.getActiveTools();
      const next = [...active].filter((name) => !hidden.has(name));
      if (next.length !== previous.length || next.some((name) => !previous.includes(name)))
        pi.setActiveTools(next);
    },
  };
}
