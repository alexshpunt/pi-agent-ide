import {
  configuredExecutableName,
  resolveExternalToolProjectRoot,
  runConfiguredFormatter,
} from "pi-agent-ide/api/tool-config";
import path from "node:path";

import { FORMATTER_RECIPES } from "./catalog.js";
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
      const projectRoot = await resolveExternalToolProjectRoot(
        context.cwd,
        filePath,
        "formatters",
        FORMATTER_RECIPES,
      );
      if (projectRoot === undefined) return { ok: true, edits: 0, formatter: null };
      const external = projectRoot !== path.resolve(context.cwd);
      const registry = await loadRegistry(projectRoot, external);
      const formatter = registry.resolve(filePath, projectRoot);

      if (formatter === undefined) {
        return { ok: true, edits: 0, formatter: null };
      }

      const name = configuredExecutableName(formatter.run.command);
      try {
        const result = await runConfiguredFormatter(formatter, {
          projectRoot,
          filePath,
        });
        return { ok: result.ok, edits: result.changed ? 1 : 0, formatter: name };
      } catch {
        return { ok: false, edits: 0, formatter: name };
      }
    },
  };
}

async function loadRegistry(cwd: string, external = false): Promise<FormatterCommandRegistry> {
  const key = JSON.stringify([cwd, external]);
  let registry = registries.get(key);

  if (registry === undefined) {
    registry = FormatterCommandRegistry.fromDirectory(cwd, {
      includeGlobal: !external,
      requireBuiltInEvidence: external,
    });
    registries.set(key, registry);
  }

  return registry;
}
