import { requiredValue } from "../utils/required-value.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { projectIdeConfigDirectory, projectIdeConfigPath } from "#src/api/tool-config.js";

import type { RecipeCandidate } from "./discovery.js";

/**
Merges selected plugin recipes into their project-local runtime configs.
*/
export async function writeSuggestedConfigs(
  cwd: string,
  candidates: readonly RecipeCandidate[],
): Promise<readonly string[]> {
  await mkdir(projectIdeConfigDirectory(cwd), { recursive: true });
  const changed: string[] = [];
  const formatters = candidates.filter((candidate) => candidate.recipe.formatter !== undefined);
  const linters = candidates.filter((candidate) => candidate.recipe.linter !== undefined);
  const servers = candidates.filter((candidate) => candidate.recipe.lsp !== undefined);

  if (formatters.length > 0) {
    const file = projectIdeConfigPath(cwd, "formatters");
    const config = await readObject(file, { version: 1, formatters: {} });
    const entries = objectMember(config, "formatters");

    for (const candidate of formatters) {
      entries[candidate.recipe.id] ??= candidate.recipe.formatter;
    }

    if (await writeJson(file, config)) {
      changed.push(file);
    }
  }

  if (linters.length > 0) {
    const file = projectIdeConfigPath(cwd, "linters");
    const config = await readObject(file, { version: 1, linters: {} });
    const entries = objectMember(config, "linters");

    for (const candidate of linters) {
      entries[candidate.recipe.id] ??= candidate.recipe.linter;
    }

    if (await writeJson(file, config)) {
      changed.push(file);
    }
  }

  if (servers.length > 0) {
    const file = projectIdeConfigPath(cwd, "lsp-servers");
    const config = await readObject(file, { version: 1, servers: {} });
    const entries = objectMember(config, "servers");

    for (const candidate of servers) {
      const recipe = requiredValue(candidate.recipe.lsp);
      entries[candidate.recipe.id] ??= {
        command: recipe.command,
        transport: "stdio",
        rootMarkers: recipe.rootMarkers,
        languages: Object.fromEntries(
          Object.entries(recipe.languageIds).map(([id, extensions]) => [id, { extensions }]),
        ),
        capabilities: ["diagnostics"],
      };
    }

    if (await writeJson(file, config)) {
      changed.push(file);
    }
  }

  return changed;
}

async function readObject(
  file: string,
  fallback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${file} must contain an object`);
    }

    return value as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

function objectMember(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }

  return value as Record<string, unknown>;
}

async function writeJson(file: string, value: unknown): Promise<boolean> {
  const content = `${JSON.stringify(value, null, 2)}\n`;

  if ((await readFile(file, "utf8").catch(() => {})) === content) {
    return false;
  }

  await writeFile(file, content, "utf8");
  return true;
}
