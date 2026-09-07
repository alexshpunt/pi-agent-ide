import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { resolveToolConfigPaths } from "pi-agent-ide/api/tool-config";

import { LSP_RECIPES } from "./catalog.js";
import { parseLspConfig } from "./lsp/registry.js";

test("the shipped LSP JSON stays aligned with the doctor catalog", async () => {
  const file = resolveToolConfigPaths(process.cwd(), "lsp-servers").builtIn;
  const config = parseLspConfig(JSON.parse(await readFile(file, "utf8")));

  expect(Object.keys(config.servers)).toEqual(LSP_RECIPES.map((recipe) => recipe.id));
  for (const recipe of LSP_RECIPES) {
    const server = config.servers[recipe.id];
    expect(server?.requireRootMarker).toBe(recipe.lsp?.requireRootMarker);

    expect(server?.settings).toEqual(recipe.lsp?.settings);

    expect(server?.initializationOptions).toEqual(recipe.lsp?.initializationOptions);
    expect(
      Object.fromEntries(
        Object.entries(server?.languages ?? {})
          .filter(([, language]) => language.fileNames !== undefined)
          .map(([id, language]) => [id, language.fileNames]),
      ),
    ).toEqual(recipe.lsp?.fileNames ?? {});
    expect(server).toMatchObject({
      command: recipe.lsp?.command,
      rootMarkers: recipe.lsp?.rootMarkers,
    });
    expect(
      Object.fromEntries(
        Object.entries(server?.languages ?? {}).map(([id, language]) => [id, language.extensions]),
      ),
    ).toEqual(recipe.lsp?.languageIds);
  }
});
