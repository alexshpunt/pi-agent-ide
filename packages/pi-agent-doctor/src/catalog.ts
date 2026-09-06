/**
A file language that an independent plugin can teach doctor to detect.
*/
export interface LanguageDefinition {
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  readonly fileNames?: readonly string[];
  readonly projectMarkers?: readonly string[];
  readonly ast?: "tree-sitter";
}

/**
Supported setup recipe categories.
*/
export type ToolRecipeKind = "formatter" | "linter" | "lsp";

/**
Safe direct process command used inside a tool recipe.
*/
export interface ProcessRecipe {
  readonly command: readonly string[];
  readonly successExitCodes?: readonly number[];
}

/**
Data-only setup recipe contributed by its owning plugin.
*/
export interface ToolRecipe {
  readonly id: string;
  readonly name: string;
  readonly kind: ToolRecipeKind;
  readonly languages: readonly string[];
  readonly executables: readonly string[];
  readonly configFiles?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly documentation: string;
  readonly conflicts?: readonly string[];
  readonly formatter?: {
    readonly extensions: readonly string[];
    readonly run: ProcessRecipe;
    readonly output: "in-place" | "stdout";
  };
  readonly linter?: {
    readonly extensions: readonly string[];
    readonly check: ProcessRecipe;
    readonly fix?: ProcessRecipe;
    readonly diagnostics: { readonly format: string; readonly pattern?: string };
  };
  readonly lsp?: {
    readonly command: readonly string[];
    readonly rootMarkers: readonly string[];
    readonly languageIds: Readonly<Record<string, readonly string[]>>;
  };
}
