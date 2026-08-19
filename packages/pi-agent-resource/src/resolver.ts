import type { Resource } from "./resource.js";

export interface ResourceResolverContext
{
    readonly cwd: string;
    readonly signal?: AbortSignal;
}

export type ResourceResolutionAttempt =
    | { readonly kind: "not-handled"; }
    | { readonly kind: "resolved"; readonly resource: Resource; }
    | { readonly kind: "failed"; readonly error: unknown; };

export type ResourceTryResolve = (
    source: string,
    context: ResourceResolverContext,
) => Promise<ResourceResolutionAttempt>;

export interface ResourceResolver
{
    readonly id: string;
    readonly tryResolve: ResourceTryResolve;
}
