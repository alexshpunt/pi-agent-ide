import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ToolRecipe } from "./catalog.js";

/** Native project evidence shared by Doctor and runtime tool selection. */
export interface RecipeEvidence {
  readonly score: number;
  readonly config?: string;
  readonly dependency?: string;
}

/** Project-bound evidence IO. Relative filenames and markers must stay with this owner. */
export interface RecipeEvidenceAccess {
  readonly readText: (file: string, signal?: AbortSignal) => Promise<string | undefined>;
  readonly hasMarker: (marker: string, signal?: AbortSignal) => Promise<boolean>;
}
/** Reads native config and declared dependencies without executing project code. */
export async function inspectRecipeEvidence(
  cwd: string,
  recipes: readonly ToolRecipe[],
  owner?: RecipeEvidenceAccess,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, RecipeEvidence>> {
  signal?.throwIfAborted();
  if (cwd.includes("://") && !owner)
    throw Object.assign(new Error("Project evidence requires its resource owner"), {
      code: "UNSUPPORTED_SOURCE",
    });
  const cache = new Map<string, Promise<string | undefined>>();
  const content = (file: string): Promise<string | undefined> => {
    let pending = cache.get(file);
    if (pending === undefined) {
      pending = owner
        ? owner.readText(file, signal)
        : readFile(path.join(cwd, file), { encoding: "utf8", signal });
      pending = pending.catch((error: unknown) => {
        signal?.throwIfAborted();
        if (owner) throw error;
        return undefined;
      });
      cache.set(file, pending);
    }
    return pending;
  };
  const rawManifest = await content("package.json");
  signal?.throwIfAborted();
  const manifest = parseJson(rawManifest);
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
        signal?.throwIfAborted();
        const found = await (
          owner ? owner.hasMarker(file, signal) : hasProjectMarker(cwd, file, signal)
        ).catch((error: unknown) => {
          signal?.throwIfAborted();
          throw error;
        });
        signal?.throwIfAborted();
        if (found) {
          config = file;
          break;
        }
      }
      if (config === undefined) {
        for (const [file, sections] of Object.entries(recipe.configSections ?? {})) {
          signal?.throwIfAborted();
          const raw = await content(file);
          signal?.throwIfAborted();
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
  signal?.throwIfAborted();
  return new Map(entries);
}

/** Matches a root-relative native filename or glob, including named project files. */
export async function hasProjectMarker(
  cwd: string,
  marker: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (cwd.includes("://"))
    throw Object.assign(new Error("Project marker requires its resource owner"), {
      code: "UNSUPPORTED_SOURCE",
    });
  if (!marker.includes("*")) {
    try {
      await access(path.join(cwd, marker));
      signal?.throwIfAborted();
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  try {
    const names = await readdir(cwd);
    signal?.throwIfAborted();
    return names.some((name) => path.matchesGlob(name, marker));
  } catch {
    signal?.throwIfAborted();
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
