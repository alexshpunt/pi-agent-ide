import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { projectIdeConfigPath } from "#src/api/tool-config.js";
import type { ToolRecipe } from "#src/api/tool-catalog.js";
import type { OwnedContribution } from "./core.js";

export interface RecipeCandidate {
  readonly pluginId: string;
  readonly recipe: ToolRecipe;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly executable?: string;
}

/**
Scores relevant recipes from concrete project evidence.
*/
export async function discoverRecipeCandidates(
  cwd: string,
  detectedLanguageIds: ReadonlySet<string>,
  recipes: readonly OwnedContribution<ToolRecipe>[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly RecipeCandidate[]> {
  const dependencies = await packageDependencies(cwd);
  const managedRecipes = await managedRecipeIds(cwd);
  const candidates: RecipeCandidate[] = [];

  for (const contribution of recipes) {
    const recipe = contribution.value;

    if (recipe.languages.every((language) => !detectedLanguageIds.has(language))) {
      continue;
    }

    const evidence: string[] = [];
    let score = 1;
    const nativeConfig = await firstExisting(cwd, recipe.configFiles ?? []);

    if (nativeConfig !== undefined) {
      score += 6;
      evidence.push(`project config: ${nativeConfig}`);
    }

    if (managedRecipes.has(`${recipe.kind}:${recipe.id}`)) {
      score += 6;
      evidence.push("Pi Agent IDE config");
    }

    const dependency = recipe.dependencies?.find((name) => dependencies.has(name));

    if (dependency !== undefined) {
      score += 4;
      evidence.push(`project dependency: ${dependency}`);
    }

    const executable = await firstExecutable(cwd, recipe.executables, environment);

    if (executable !== undefined) {
      score += 3;
      evidence.push(`executable: ${executable}`);
    }

    candidates.push({
      pluginId: contribution.pluginId,
      recipe,
      score,
      evidence,
      ...(executable && { executable }),
    });
  }

  return candidates.sort(
    (left, right) => right.score - left.score || left.recipe.id.localeCompare(right.recipe.id),
  );
}

/**
Selects at most one recipe per language and tool kind.
*/
export function selectSuggestedRecipes(
  candidates: readonly RecipeCandidate[],
  detectedLanguageIds: ReadonlySet<string>,
): readonly RecipeCandidate[] {
  const selected = new Map<string, RecipeCandidate>();

  for (const language of detectedLanguageIds) {
    for (const kind of ["formatter", "linter", "lsp"] as const) {
      const matches = candidates.filter(
        (candidate) =>
          candidate.recipe.kind === kind &&
          candidate.recipe.languages.includes(language) &&
          candidate.executable !== undefined &&
          candidate.score >= 4,
      );
      const best = matches[0];

      if (best === undefined) {
        continue;
      }

      if (matches.filter((candidate) => candidate.score === best.score).length > 1) {
        continue;
      }

      selected.set(best.recipe.id, best);
    }
  }

  return [...selected.values()];
}

async function firstExisting(cwd: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await access(path.join(cwd, name));
      return name;
    } catch {
      // Try the next project marker.
    }
  }

  return undefined;
}

async function firstExecutable(
  cwd: string,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathDirectories = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const directories = [path.join(cwd, "node_modules", ".bin"), ...pathDirectories];

  for (const name of names) {
    if (name.includes(path.sep)) {
      try {
        await access(path.resolve(cwd, name));
        return name;
      } catch {
        continue;
      }
    }

    for (const directory of directories) {
      try {
        await access(path.join(directory, name));
        return name;
      } catch {
        // Try the next executable location.
      }
    }
  }

  return undefined;
}

async function managedRecipeIds(cwd: string): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();

  for (const [name, sectionName, kind] of [
    ["formatters", "formatters", "formatter"],
    ["linters", "linters", "linter"],
    ["lsp-servers", "servers", "lsp"],
  ] as const) {
    try {
      const value: unknown = JSON.parse(await readFile(projectIdeConfigPath(cwd, name), "utf8"));

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue;
      }

      const record = value as Record<string, unknown>;
      const section = record[sectionName];

      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        for (const id of Object.keys(section)) {
          ids.add(`${kind}:${id}`);
        }
      }
    } catch {
      // A missing or invalid managed config provides no discovery evidence.
    }
  }

  return ids;
}

async function packageDependencies(cwd: string): Promise<ReadonlySet<string>> {
  try {
    const value = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();

    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const section = value[key];

      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        for (const name of Object.keys(section)) {
          names.add(name);
        }
      }
    }

    return names;
  } catch {
    return new Set();
  }
}
