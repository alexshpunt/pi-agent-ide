# Resource resolver contract

## Purpose

This document defines how a source reference is resolved to a `pi-agent-resource` Resource.

A resolver owns source recognition and resource creation. A consuming core owns the resolver registry, ordering, invocation, and conversion of resolution failures to its capability-specific result.

The returned resource is defined in [`resource.md`](./resource.md).

Runtime shape validation is defined in [`runtime-validation.md`](./runtime-validation.md).

## Public types

```ts
import type { Resource } from "pi-agent-resource";

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
```

## Resolver identity

`id` is a required, non-empty string owned by the resolver.

The ID is stable for that resolver implementation. A consuming registry uses it for diagnostics and duplicate checks.

The contract does not require a namespace, provider field, or version field. Resolver ID uniqueness is enforced inside the registry that accepts it, not process-wide.

Registration priority is not part of `ResourceResolver`. It belongs to the consuming core's registration contract.

## Source reference

`source` is a non-empty opaque string supplied by the consuming core.

A resolver may interpret it as a path, URI, remote key, or another source-specific reference. Generic code does not infer source kind from the string.

The resolver returns a Resource whose `source` is its canonical source reference. The canonical source may differ from the requested reference.

## Resolver context

`cwd` is the absolute current working directory for this resolution attempt. Filesystem-like resolvers may use it to resolve relative references. Other resolvers may ignore it.

`signal` is optional because resolution may run outside a cancellable agent turn.

The context contains no generic metadata map or capability-specific fields.

## Single resolution operation

Source recognition and resource creation happen in one `tryResolve` call.

The common contract does not define a separate `canResolve`, `matches`, or probe method. A single call avoids duplicated I/O and a race between recognition and resource creation.

`tryResolve` is always asynchronous and returns a `Promise<ResourceResolutionAttempt>`.

## Resolution outcomes

### not-handled

```ts
const attempt: ResourceResolutionAttempt = {
    kind: "not-handled",
};
```

The resolver returns `not-handled` only when the source reference is outside the resolver's domain.

A consuming core may continue to the next resolver after this outcome.

### resolved

```ts
const attempt: ResourceResolutionAttempt = {
    kind: "resolved",
    resource,
};
```

The resolver recognized the source and created a valid Resource.

A consuming core stops resolver selection after this outcome.

The returned Resource may be read-only, write-only, or read-write. A missing capability does not change the outcome to `not-handled`.

### failed

```ts
const attempt: ResourceResolutionAttempt = {
    kind: "failed",
    error,
};
```

The resolver owns the source reference but could not create a usable Resource.

Denied access, an unavailable source, an invalid owned reference, source I/O failure, and cancellation are `failed` outcomes.

A consuming core stops resolver selection after this outcome. It does not fall back to a later resolver.

`error` is the original source error. `pi-agent-resource` does not require a common resolution error class, code, or message wrapper.

## Thrown and rejected failures

A resolver returns `failed` for expected source failures.

If `tryResolve` throws or returns a rejected promise, the consuming core treats that error as a terminal failed attempt from the same resolver. It does not continue fallback.

This runtime normalization protects the resolver chain, but integrations should use the explicit `failed` outcome for expected failures.

## Cancellation

A resolver honors `context.signal` on a best-effort basis.

It checks an already-aborted signal before starting new work and passes the signal to abort-aware source APIs when available.

Cancelled resolution is terminal. It produces a `failed` attempt whose error has `name === "AbortError"`.

Cancellation is never represented as `not-handled` and never advances to another resolver.

## Registry boundary

This package does not define:

- resolver registration;
- resolver priority;
- duplicate-ID policy beyond requiring registry-local uniqueness;
- resolver snapshots;
- selection order;
- retries;
- fallback after a terminal outcome.

Each consuming core owns those behaviors. Independent cores may register different resolver sets and resolve the same source differently.

## Invariants

1. Resolver ID is non-empty and stable.
2. Source references are opaque to generic code.
3. Resolution uses one asynchronous `tryResolve` call.
4. `not-handled` means the resolver does not own the source.
5. `resolved` returns one valid Resource.
6. `failed` means the resolver owns the source but resolution did not succeed.
7. `resolved` and `failed` are terminal for the current resolver chain.
8. Cancellation is a terminal `failed` outcome with an `AbortError`.
9. Expected source failures preserve the original error.
10. Registry and ordering policy remain outside this package.
