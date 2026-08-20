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

export interface SearchPluginApi {
  addResolver(registration: SearchResolverRegistration): void;
  addAction(registration: SearchActionRegistration): void;
  describe(description: SearchDescriptionSource): void;
  search(request: SearchRequest, context: SearchContext): Promise<AgentToolResult<unknown>>;
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
