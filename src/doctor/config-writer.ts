import { requiredValue } from "pi-agent-invariant";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { projectIdeConfigDirectory, projectIdeConfigPath } from "#src/api/tool-config.js";
import type { DoctorWorkspace } from "#src/api/doctor.js";

import type { RecipeCandidate } from "./discovery.js";

type ConfigAccess = Pick<DoctorWorkspace, "source" | "configPaths" | "readText" | "writeText">;

/**
Merges selected plugin recipes into their project-local runtime configs.
*/
export async function writeSuggestedConfigs(
  cwd: string,
  candidates: readonly RecipeCandidate[],
  workspace?: ConfigAccess,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  if ((cwd.includes("://") && !workspace) || (workspace && workspace.source !== cwd)) {
    throw Object.assign(new Error("Doctor configuration needs its project owner"), {
      code: "UNSUPPORTED_SOURCE",
    });
  }
  if (!workspace) await mkdir(projectIdeConfigDirectory(cwd), { recursive: true });
  const changed: string[] = [];
  const formatters = candidates.filter((candidate) => candidate.recipe.formatter !== undefined);
  const linters = candidates.filter((candidate) => candidate.recipe.linter !== undefined);
  const servers = candidates.filter((candidate) => candidate.recipe.lsp !== undefined);

  if (formatters.length > 0) {
    const file = workspace
      ? (await workspace.configPaths("formatters", signal)).project
      : projectIdeConfigPath(cwd, "formatters");
    const { config, previous } = await readObject(
      file,
      { version: 1, formatters: {} },
      workspace,
      signal,
    );
    const entries = objectMember(config, "formatters");

    for (const candidate of formatters) {
      entries[candidate.recipe.id] ??= candidate.recipe.formatter;
    }

    if (await writeJson(file, config, previous, workspace, signal)) {
      changed.push(file);
    }
  }

  if (linters.length > 0) {
    const file = workspace
      ? (await workspace.configPaths("linters", signal)).project
      : projectIdeConfigPath(cwd, "linters");
    const { config, previous } = await readObject(
      file,
      { version: 1, linters: {} },
      workspace,
      signal,
    );
    const entries = objectMember(config, "linters");

    for (const candidate of linters) {
      entries[candidate.recipe.id] ??= candidate.recipe.linter;
    }

    if (await writeJson(file, config, previous, workspace, signal)) {
      changed.push(file);
    }
  }

  if (servers.length > 0) {
    const file = workspace
      ? (await workspace.configPaths("lsp-servers", signal)).project
      : projectIdeConfigPath(cwd, "lsp-servers");
    const { config, previous } = await readObject(
      file,
      { version: 1, servers: {} },
      workspace,
      signal,
    );
    const entries = objectMember(config, "servers");

    for (const candidate of servers) {
      const recipe = requiredValue(candidate.recipe.lsp);
      entries[candidate.recipe.id] ??= {
        command: recipe.command,
        transport: "stdio",
        rootMarkers: recipe.rootMarkers,

        ...(recipe.initializationOptions !== undefined && {
          initializationOptions: recipe.initializationOptions,
        }),

        ...(recipe.settings !== undefined && { settings: recipe.settings }),

        ...(recipe.requireRootMarker !== undefined && {
          requireRootMarker: recipe.requireRootMarker,
        }),
        languages: Object.fromEntries(
          Object.entries(recipe.languageIds).map(([id, extensions]) => [
            id,
            { extensions, ...(recipe.fileNames?.[id] && { fileNames: recipe.fileNames[id] }) },
          ]),
        ),
        capabilities: ["diagnostics"],
      };
    }

    if (await writeJson(file, config, previous, workspace, signal)) {
      changed.push(file);
    }
  }

  return changed;
}

async function readObject(
  file: string,
  fallback: Record<string, unknown>,
  workspace?: ConfigAccess,
  signal?: AbortSignal,
): Promise<{ config: Record<string, unknown>; previous: string | undefined }> {
  let previous: string | undefined;
  try {
    previous = workspace
      ? await workspace.readText(file, signal)
      : await readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  signal?.throwIfAborted();
  if (previous === undefined) return { config: fallback, previous };
  const value: unknown = JSON.parse(previous);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} must contain an object`);
  }
  return { config: value as Record<string, unknown>, previous };
}

function objectMember(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }

  return value as Record<string, unknown>;
}

async function writeJson(
  file: string,
  value: unknown,
  previous: string | undefined,
  workspace?: ConfigAccess,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (previous === content) return false;
  if (workspace) await workspace.writeText(file, content, previous, signal);
  else await writeFile(file, content, { encoding: "utf8", signal });
  return true;
}
