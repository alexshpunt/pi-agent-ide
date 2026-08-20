import { runConfiguredFormatter } from "pi-agent-ide/api/tool-config";

import { FormatterCommandRegistry } from "./registry.js";

import type { Formatter } from "pi-agent-ide/api/toolchain";

const registries = new Map<string, Promise<FormatterCommandRegistry>>();

/**
Creates a formatter backed by `.pi/pi-agent-ide/formatters.json`.
*/
export function createFormatter(): Formatter {
  return {
    kind: "formatter",
    name: "formatter",
    priority: 100,
    extensions: ["*"],
    detect: async (context) => {
      await loadRegistry(context.cwd);
      return true;
    },
    async format({ filePath }, context) {
      const registry = await loadRegistry(context.cwd);
      const formatter = registry.resolve(filePath, context.cwd);

      if (formatter === undefined) {
        return { ok: true, edits: 0 };
      }

      const result = await runConfiguredFormatter(formatter, {
        projectRoot: context.cwd,
        filePath,
      });
      return { ok: result.ok, edits: result.changed ? 1 : 0 };
    },
  };
}

async function loadRegistry(cwd: string): Promise<FormatterCommandRegistry> {
  let registry = registries.get(cwd);

  if (registry === undefined) {
    registry = FormatterCommandRegistry.fromDirectory(cwd);
    registries.set(cwd, registry);
  }

  return registry;
}
