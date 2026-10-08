import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedResultTargets } from "pi-agent-resource";

export interface SearchRequest {
  readonly query: string;
  readonly path?: string;
  readonly include?: string;
  readonly exclude?: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly limit?: number;
  /** Explicitly follow scoped LSP symbols to references outside the input scope. */
  readonly navigation?: "references";
}

/** Public calls accept registered result objects; resolvers receive normalized string paths. */
export interface SearchInput extends Omit<SearchRequest, "path"> {
  readonly path?: string | object | readonly unknown[];
}

/** Backend-owned filesystem identity and a bounded, cancellable ripgrep line stream.
 * Paths stay canonical; implementations must not fall back to a local executor.
 */
export interface SearchEnvironment {
  resolve(cwd: string, source: string): string;
  dirname(source: string): string;
  basename(source: string): string;
  isDirectory(source: string, signal?: AbortSignal): Promise<boolean>;
  /** Read source size on this owner before bounded candidate snapshot capture. */
  byteSize?(source: string, signal?: AbortSignal): Promise<number>;
  readText(source: string, signal?: AbortSignal): Promise<string>;
  /** Run exact argv on this owner, with bounded output and cancellation.
   * Missing execution support must reject structural queries, never run locally.
   */
  execute?(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  runLines(
    arguments_: readonly string[],
    cwd: string,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stderr: string }>;
}
/** Return undefined only for unowned scopes; reject invalid owned scopes. */
export type SearchEnvironmentProvider = (
  request: SearchRequest,
  context: SearchContext,
) => SearchEnvironment | undefined;
export interface SearchContext {
  /** Select an existing lazy owner for one canonical source in a mixed result scope. */
  readonly environmentForSource?: (source: string) => SearchEnvironment | undefined;
  /** Trusted snapshot scopes resolved by the owning tool; never accepted as raw JSON coordinates. */
  readonly scope?: ResolvedResultTargets;
  readonly environment?: SearchEnvironment;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onUpdate?: (result: AgentToolResult<unknown>) => void;
}

export type SearchResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly payload: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

export interface SearchResolver {
  /** Handle exact source ranges instead of widening a structured input to a path. */
  readonly supportsResultScope?: boolean;
  /** Complete read scope for resolving and formatting. Empty means no resource reads;
   * undefined means unknown scope, compatible with reads but conflicting with every write.
   * Declaring a scope must not read resource contents.
   */
  readonly readResources?: (
    request: SearchRequest,
    context: SearchContext,
  ) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /** Required for native data calls; project only documented JSON domain fields. */
  readonly toScriptData?: (payload: unknown, formattedDetails: unknown) => unknown;
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
  /** Shared immutable source targets, independent of legacy SEARCH refresh handles. */
  readonly target?: string;
  readonly matchTargets?: readonly string[];
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
}
export type SearchSelectionProvider = (
  selection: SearchSelectionRegistration,
  context: SearchContext,
) => Promise<RegisteredSearchSelection>;
export interface SearchPluginApi {
  /** Add a lazy scope owner. Failed plugin setup must not retain its provider. */
  addEnvironmentProvider(provider: SearchEnvironmentProvider): void;
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
    request: SearchInput,
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
export { renderSearchMatches } from "./presentation.js";
export { containsSearchMatch } from "./search-scope.js";
export {
  fuzzyLimits,
  isFuzzyResultData,
  FuzzyVocabulary,
  isFuzzyQuery,
  rankFuzzyIdentifiers,
  fuzzyCandidateData,
  formatFuzzyCandidate,
} from "#src/api/fuzzy.js";
export type {
  FuzzyIdentifier,
  FuzzyResultData,
  FuzzyCandidate,
  FuzzyResult,
  FuzzyCandidateData,
} from "#src/api/fuzzy.js";
export { searchDataSchema, searchOutputSchema, selectionData } from "./structured-result.js";
