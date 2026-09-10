import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface SearchRequest {
  readonly query: string;
  readonly path?: string;
  readonly include?: string;
  readonly exclude?: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly limit?: number;
}

export interface SearchContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onUpdate?: (result: AgentToolResult<unknown>) => void;
}

export type SearchResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly payload: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

export interface SearchResolver {
  readonly id: string;
  tryResolve(
    request: SearchRequest,
    context: SearchContext,
  ): SearchResolutionAttempt | Promise<SearchResolutionAttempt>;
  format(
    payload: unknown,
    context: SearchContext,
  ): AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>;
  readonly renderResult?: ToolDefinition["renderResult"];
}

export interface SearchResolverRegistration {
  readonly resolver: SearchResolver;
  readonly priority?: number;
  /** Handle unclaimed text after specialized resolvers; also accept empty protocol queries. */
  readonly fallback?: boolean;
}

export type SearchDescriptionSource = string | (() => string | undefined);

export interface SearchReference {
  readonly value: string;
  readonly resolverId: string;
  readonly capabilities: readonly string[];
}

export interface SearchActionRequest {
  readonly reference: string;
  readonly resolverId: string;
  readonly capability: string;
  readonly input: unknown;
}

export interface SearchActionRegistration {
  readonly resolverId: string;
  readonly capability: string;
  execute(reference: string, input: unknown, context: SearchContext): Promise<unknown>;
}

/** Full resolver data plus registered selection details, separate from rendered output. */
export interface SearchScriptData {
  readonly resolverId: string;
  readonly data: unknown;
  readonly details: unknown;
}

/** A search execution with optional data for script callers. */
export interface SearchToolResult extends AgentToolResult<SearchToolDetails> {
  readonly script?: SearchScriptData;
}
/** Exact text ranges discovered by any search backend. Columns are zero-based UTF-16 offsets. */
export interface SearchSelectionMatch {
  readonly source: string;
  readonly lineNumber: number;
  readonly endLineNumber?: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly matchedText: string;
  readonly lineText: string;
}
export interface SearchSelectionSnapshot {
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
  readonly notices?: readonly string[];
}
/** Keep the original backend when refreshing an all-selection or observing an edit. */
export interface SearchSelectionRegistration extends SearchSelectionSnapshot {
  readonly request: SearchRequest;
  readonly refresh: (signal?: AbortSignal) => Promise<SearchSelectionSnapshot>;
}
export interface RegisteredSearchSelection {
  readonly id: string;
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
}
export type SearchSelectionProvider = (
  selection: SearchSelectionRegistration,
  context: SearchContext,
) => Promise<RegisteredSearchSelection>;
export interface SearchPluginApi {
  addResolver(registration: SearchResolverRegistration): void;
  /** Register the one shared SEARCH reference store. */
  addSelectionProvider(provider: SearchSelectionProvider): void;
  /** Register exact ranges with the shared store, retaining backend refresh behavior. */
  registerSelection(
    selection: SearchSelectionRegistration,
    context: SearchContext,
  ): Promise<RegisteredSearchSelection>;
  addAction(registration: SearchActionRegistration): void;
  describe(description: SearchDescriptionSource): void;
  /** Add an operational guideline while this search plugin is active. */
  addPromptGuideline(guideline: SearchDescriptionSource): void;
  /** Execute configured resolvers and register references before returning script data. */
  search(
    request: SearchRequest,
    context: SearchContext,
    audience?: "agent" | "script",
  ): Promise<SearchToolResult>;
  runAction(request: SearchActionRequest, context: SearchContext): Promise<unknown>;
}

export interface SearchToolDetails {
  readonly resolverId?: string;
  readonly payload?: unknown;
  readonly failure?: {
    readonly code:
      | "INVALID_REQUEST"
      | "NO_RESOLVER"
      | "RESOLVE_FAILED"
      | "INVALID_RESOLVER_RESULT"
      | "FORMAT_FAILED";
    readonly message: string;
    readonly resolverId?: string;
    readonly cause?: unknown;
  };
}

export { searchSchema } from "#src/api/search-parameters.js";
