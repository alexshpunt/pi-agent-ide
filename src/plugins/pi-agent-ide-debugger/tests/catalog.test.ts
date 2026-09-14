import { expect, test } from "vitest";

import {
  DEBUGGER_LANGUAGE_MATRIX,
  DEBUGGER_RECIPES,
  debuggerRecipeForLanguage,
} from "#src/plugins/pi-agent-ide-debugger/src/catalog.js";

const EXECUTABLE_LSP_LANGUAGES = [
  "c",
  "cpp",
  "csharp",
  "dart",
  "elixir",
  "go",
  "java",
  "javascript",
  "julia",
  "kotlin",
  "lua",
  "php",
  "powershell",
  "python",
  "r",
  "ruby",
  "rust",
  "shell",
  "swift",
  "typescript",
  "zig",
] as const;

test("debugger matrix accounts for every executable LSP language", () => {
  expect(DEBUGGER_LANGUAGE_MATRIX.map(({ language }) => language).sort()).toEqual(
    [...EXECUTABLE_LSP_LANGUAGES].sort(),
  );
});

test("only verified matrix entries are advertised as debugger recipes", () => {
  const verified = DEBUGGER_LANGUAGE_MATRIX.filter(({ status }) => status === "verified").map(
    ({ language }) => language,
  );
  expect(DEBUGGER_RECIPES.flatMap(({ languages }) => languages).sort()).toEqual(verified.sort());
  for (const language of verified) expect(debuggerRecipeForLanguage(language)).toBeDefined();
  for (const recipe of DEBUGGER_RECIPES) {
    expect(recipe.debugger).toBeDefined();
    expect(recipe.debugger?.platforms).toContain("linux");
    expect(recipe.debugger?.install.length).toBeGreaterThan(0);
  }
});
