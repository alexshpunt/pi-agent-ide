import {
  configuredExecutableName,
  resolveExternalToolProjectRoot,
  runConfiguredFormatter,
} from "pi-agent-ide/api/tool-config";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { FORMATTER_RECIPES } from "./catalog.ts";
import { FormatterCommandRegistry } from "./registry.ts";
import { localRustfmtAccess, rustfmtWithEdition, type RustfmtAccess } from "./rustfmt.ts";

import type { Formatter } from "pi-agent-ide/api/toolchain";
import type { FormatterCommandConfig } from "pi-agent-ide/api/tool-config";

/** Project, configuration and execution stay with the selected resource owner. */
export interface FormatterRuntime {
  resolveProject(
    source: string,
    cwd: string,
  ): Promise<{ cwd: string; external: boolean } | undefined>;
  loadRegistry(cwd: string, external: boolean): Promise<FormatterCommandRegistry>;
  rustfmtAccess?(
    projectRoot: string,
    source: string,
  ): Promise<{ file: string; access: RustfmtAccess }>;
  run(
    config: FormatterCommandConfig,
    projectRoot: string,
    source: string,
  ): Promise<{ ok: boolean; changed: boolean }>;
}

const registries = new Map<string, Promise<FormatterCommandRegistry>>();

/**
Creates a formatter backed by `.pi/pi-agent-ide/formatters.json`.
*/
export function createFormatter(runtime?: FormatterRuntime): Formatter {
  return {
    kind: "formatter",
    name: "formatter",
    priority: 100,
    extensions: ["*"],
    detect: async (context) => {
      if (runtime) await runtime.loadRegistry(context.cwd, false);
      else await loadRegistry(context.cwd);
      return true;
    },
    async format({ filePath, before }, context) {
      if (!runtime && (filePath.includes("://") || context.cwd.includes("://")))
        throw Object.assign(new Error("Formatter requires its resource owner"), {
          code: "UNSUPPORTED_SOURCE",
        });
      const project = runtime
        ? await runtime.resolveProject(filePath, context.cwd)
        : await resolveExternalToolProjectRoot(
            context.cwd,
            filePath,
            "formatters",
            FORMATTER_RECIPES,
          ).then((cwd) =>
            cwd === undefined ? undefined : { cwd, external: cwd !== path.resolve(context.cwd) },
          );
      if (project === undefined) return { ok: true, edits: 0, formatter: null };
      const projectRoot = project.cwd;
      const registry = runtime
        ? await runtime.loadRegistry(projectRoot, project.external)
        : await loadRegistry(projectRoot, project.external);
      const entry = registry.resolveEntry(filePath, projectRoot);
      let formatter = entry?.config;

      if (formatter === undefined) {
        return { ok: true, edits: 0, formatter: null };
      }

      if (entry?.layer === "built-in" && entry.id === "rustfmt") {
        try {
          const selected = runtime?.rustfmtAccess
            ? await runtime.rustfmtAccess(projectRoot, filePath)
            : {
                file: path.join(await realpath(path.dirname(filePath)), path.basename(filePath)),
                access: localRustfmtAccess(projectRoot, filePath),
              };
          formatter = await rustfmtWithEdition(formatter, selected.file, selected.access);
          if (before !== undefined && before.length > 0) {
            const command = formatter.run.command.filter((part) => part !== "{file}");
            const baseline = await selected.access.run(
              { ...formatter.run, command: [...command, "--emit", "stdout"], cwd: "file" },
              before,
            );
            if (!baseline.ok) return { ok: false, edits: 0, formatter: "rustfmt" };
            if (baseline.stdout !== before)
              return { ok: true, edits: 0, formatter: "rustfmt", skipped: "style" };
          }
        } catch {
          return { ok: false, edits: 0, formatter: "rustfmt" };
        }
      }
      const name = configuredExecutableName(formatter.run.command);
      if (runtime) {
        const result = await runtime.run(formatter, projectRoot, filePath);
        return { ok: result.ok, edits: result.changed ? 1 : 0, formatter: name };
      }
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
      requireBuiltInEvidence: true,
    });
    registries.set(key, registry);
  }

  return registry;
}
