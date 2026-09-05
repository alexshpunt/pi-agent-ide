import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { discoverRecipeCandidates, selectSuggestedRecipes } from "./discovery.js";

import type { ToolRecipe } from "#src/api/tool-catalog.js";
import type { OwnedContribution } from "./core.js";
import type { RecipeCandidate } from "./discovery.js";

it("does not choose between equally supported tools", () => {
  const candidates: RecipeCandidate[] = [candidate("biome"), candidate("prettier")];
  expect(selectSuggestedRecipes(candidates, new Set(["typescript"]))).toEqual([]);
});

it("does not suggest the tool already selected by the effective runtime", () => {
  const prettier = candidate("prettier");
  expect(
    selectSuggestedRecipes([prettier], new Set(["typescript"]), [
      { kind: "formatter", languageId: "typescript", toolId: "prettier" },
    ]),
  ).toEqual([]);
});

it("requires project evidence before replacing another active tool", () => {
  const prettier = { ...candidate("prettier"), score: 4, evidence: ["executable: prettier"] };
  expect(
    selectSuggestedRecipes([prettier], new Set(["typescript"]), [
      { kind: "formatter", languageId: "typescript", toolId: "biome" },
    ]),
  ).toEqual([]);
});

it("treats managed tool mappings as project evidence", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agent-doctor-discovery-"));

  try {
    await mkdir(path.join(cwd, ".pi", "pi-agent-ide"), { recursive: true });
    await mkdir(path.join(cwd, "node_modules", ".bin"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "pi-agent-ide", "linters.json"),
      JSON.stringify({ version: 1, linters: { eslint: {} } }),
      "utf8",
    );
    await writeFile(path.join(cwd, "node_modules", ".bin", "eslint"), "fixture", "utf8");
    const recipe: ToolRecipe = {
      id: "eslint",
      name: "ESLint",
      kind: "linter",
      languages: ["javascript"],
      executables: ["eslint"],
      configFiles: ["eslint.config.js"],
      documentation: "https://eslint.org",
      linter: {
        extensions: [".js"],
        check: { command: ["eslint", "{file}"] },
        diagnostics: { format: "regex", pattern: "fixture" },
      },
    };
    const recipes: OwnedContribution<ToolRecipe>[] = [{ pluginId: "lint", value: recipe }];

    const [result] = await discoverRecipeCandidates(cwd, new Set(["javascript"]), recipes, {
      PATH: "",
    });

    expect(result).toMatchObject({
      executable: "eslint",
      evidence: ["Pi Agent IDE config", "executable: eslint"],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function candidate(id: string): RecipeCandidate {
  return {
    pluginId: "formatter",
    score: 10,
    evidence: [`project config: ${id}.json`, `executable: ${id}`],
    executable: id,
    recipe: {
      id,
      name: id,
      kind: "formatter",
      languages: ["typescript"],
      executables: [id],
      documentation: "https://example.com",
      formatter: { extensions: [".ts"], run: { command: [id, "{file}"] }, output: "in-place" },
    },
  };
}
