import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ToolRecipe } from "./catalog.js";

/** Native project evidence shared by Doctor and runtime tool selection. */
export interface RecipeEvidence {
  readonly score: number;
  readonly config?: string;
  readonly dependency?: string;
}

/** Reads native config and declared dependencies without executing project code. */
export async function inspectRecipeEvidence(
  cwd: string,
  recipes: readonly ToolRecipe[],
): Promise<ReadonlyMap<string, RecipeEvidence>> {
  const cache = new Map<string, Promise<string | undefined>>();
  const content = (file: string): Promise<string | undefined> => {
    let pending = cache.get(file);
    if (pending === undefined) {
      pending = readFile(path.join(cwd, file), "utf8").catch(() => undefined);
      cache.set(file, pending);
    }
    return pending;
  };
  const manifest = parseJson(await content("package.json"));
  const dependencies = new Set<string>();
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = manifest?.[key];
    if (isRecord(section)) {
      for (const name of Object.keys(section)) dependencies.add(name);
    }
  }
  const entries = await Promise.all(
    recipes.map(async (recipe) => {
      let config: string | undefined;
      for (const file of recipe.configFiles ?? []) {
        if (await hasProjectMarker(cwd, file)) {
          config = file;
          break;
        }
      }
      if (config === undefined) {
        for (const [file, sections] of Object.entries(recipe.configSections ?? {})) {
          const raw = await content(file);
          if (raw === undefined) continue;
          const json = file.endsWith(".json") ? parseJson(raw) : undefined;
          if (
            sections.some((section) =>
              json === undefined
                ? raw.split(/\r?\n/).some((line) => {
                    const table = /^\s*\[([^\]]+)\]/.exec(line)?.[1]?.trim();
                    return table === section || table?.startsWith(`${section}.`) === true;
                  })
                : jsonSection(json, section) !== undefined,
            )
          ) {
            config = file;
            break;
          }
        }
      }
      const dependency = recipe.dependencies?.find((name) => dependencies.has(name));
      return [
        recipe.id,
        {
          score: (config === undefined ? 0 : 6) + (dependency === undefined ? 0 : 4),
          ...(config !== undefined && { config }),
          ...(dependency !== undefined && { dependency }),
        },
      ] as const;
    }),
  );
  return new Map(entries);
}

/** Matches a root-relative native filename or glob, including named project files. */
export async function hasProjectMarker(cwd: string, marker: string): Promise<boolean> {
  if (!marker.includes("*")) {
    try {
      await access(path.join(cwd, marker));
      return true;
    } catch {
      return false;
    }
  }
  try {
    const names = await readdir(cwd);
    return names.some((name) => path.matchesGlob(name, marker));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function jsonSection(value: Record<string, unknown>, section: string): unknown {
  let current: unknown = value;
  for (const key of section.split(".")) current = isRecord(current) ? current[key] : undefined;
  return current;
}
