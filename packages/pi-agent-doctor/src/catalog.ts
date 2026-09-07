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

  /** Named TOML tables or JSON paths that identify a tool inside a shared config file. */
  readonly configSections?: Readonly<Record<string, readonly string[]>>;
  readonly dependencies?: readonly string[];
  readonly documentation: string;
  readonly conflicts?: readonly string[];
  readonly formatter?: {
    readonly extensions: readonly string[];

    /** Exact basenames accepted in addition to the file extensions. */
    readonly fileNames?: readonly string[];
    readonly run: ProcessRecipe;
    readonly output: "in-place" | "stdout";
  };
  readonly linter?: {
    readonly extensions: readonly string[];

    /** Exact basenames accepted in addition to the file extensions. */
    readonly fileNames?: readonly string[];
    readonly check: ProcessRecipe;
    readonly fix?: ProcessRecipe;
    readonly diagnostics: {
      readonly format: string;
      readonly pattern?: string;
      /** Native regex reporter column numbering, converted to one-based IDE positions. */
      readonly columnBase?: 0 | 1;
    };
  };
  readonly lsp?: {
    readonly command: readonly string[];
    readonly rootMarkers: readonly string[];

    /** Limit selection to files below a matching native project marker. */
    readonly requireRootMarker?: boolean;

    /** Default language-server settings, sent through the LSP configuration protocol. */
    readonly settings?: Readonly<Record<string, unknown>>;

    /** Initialization data; string values can contain the {project} path placeholder. */
    readonly initializationOptions?: Readonly<Record<string, unknown>>;
    readonly languageIds: Readonly<Record<string, readonly string[]>>;

    /** Exact basenames grouped by LSP language ID. */
    readonly fileNames?: Readonly<Record<string, readonly string[]>>;
  };
}
