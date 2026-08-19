# Resource contract

## Purpose

This document defines the resource returned by a `pi-agent-resource` resolver.

A resource identifies one resolved source and exposes reading, writing, or both. It contains no resolver registration, pipeline, or source-specific policy.

The content exchanged by resource operations is defined in [`agent-content.md`](./agent-content.md).

Runtime shape validation is defined in [`runtime-validation.md`](./runtime-validation.md).

## Public types

```ts
import type { AgentContent } from "pi-agent-resource";

export interface ResourceOperationContext
{
    readonly signal?: AbortSignal;
}

export type ResourceRead = (
    context: ResourceOperationContext,
) => Promise<AgentContent>;

export type ResourceWrite = (
    content: AgentContent,
    context: ResourceOperationContext,
) => Promise<void>;

export interface ResourceBase
{
    readonly source: string;
}

export interface ReadableResource extends ResourceBase
{
    readonly read: ResourceRead;
    readonly write?: never;
}

export interface WritableResource extends ResourceBase
{
    readonly read?: never;
    readonly write: ResourceWrite;
}

export interface ReadWriteResource extends ResourceBase
{
    readonly read: ResourceRead;
    readonly write: ResourceWrite;
}

export type Resource =
    | ReadableResource
    | WritableResource
    | ReadWriteResource;
```

## Resource identity

`source` is a required, non-empty string.

It is the canonical source reference chosen by the resolver. It may differ from the reference originally supplied by the caller.

`source` is used for diagnostics and as the stable source reference during the current consuming operation. It is not a process-global resource ID and does not imply equality between independent resolver registries.

The resource contains no opaque ID or unrestricted metadata map.

`link` is an optional navigation target for user interfaces. It does not identify or resolve the Resource. A consumer may show `source` without a link when this field is absent.

## Capabilities

The presence of `read` and `write` is the capability declaration.

A resource has exactly one of these shapes:

- read-only;
- write-only;
- read-write.

The structural union makes a resource with neither operation invalid at the TypeScript boundary. There are no separate `canRead` or `canWrite` flags.

Consumers narrow the union by checking operation presence.

```ts
if (resource.read !== undefined)
{
    const content = await resource.read(context);
}
```

## Read operation

`read` materializes and returns one complete `AgentContent` value.

The resource contract does not provide streaming, byte ranges, line ranges, projection, or truncation. A consuming core applies those behaviors after reading when they belong to that capability.

A successful read always returns non-empty `AgentContent`.

## Write operation

`write` receives one complete `AgentContent` value and resolves with `void` after the source-specific write operation completes.

The source integration owns the meaning of writing. A filesystem writer may replace stored content. A log writer may append content. The common contract does not add separate replace or append capabilities.

A successful write does not return persisted content, metadata, a revision, or an application status.

A writable Resource performs its own write. Consumers do not look up a separate writer by resource kind.

## Operation context

Every operation receives a `ResourceOperationContext` object.

`signal` is optional because a resource may be used when no cancellable agent turn is active.

The context contains no `cwd`. Relative source interpretation is complete before the resolver returns the resource.

The context contains no generic metadata extension point.

## Failures

A source-specific read or write failure rejects the operation promise with the source error.

`pi-agent-resource` does not wrap failures in a common `ResourceError` and does not return tagged success or failure outcomes from resource operations.

The consuming core owns conversion from a source error to its agent-facing failure contract.

## Cancellation

An operation honors `context.signal` on a best-effort basis.

An integration checks an already-aborted signal before starting new work and passes the signal to abort-aware source APIs when available.

A cancelled operation rejects with an error whose `name` is `"AbortError"`. The package does not require one concrete error class.

The consuming core owns cancellation presentation and recovery.

## Write effects after failure

The common contract does not guarantee atomic writes.

If a write fails or is cancelled, the source may contain no change, a partial change, or a complete change whose acknowledgement was interrupted. The source integration owns and documents those semantics.

The `Promise<void>` result carries no applied or partial status.

## Lifetime

A resource belongs to one resolution and one consuming operation. A later tool call resolves the source again.

The contract provides no cross-call cache, shared identity, close method, or long-lived cleanup protocol. A source integration completes operation-local cleanup before its work settles.

## Invariants

1. `source` is non-empty.
2. A resource exposes read, write, or both.
3. Capability checks use operation presence, not duplicate flags.
4. Read returns one complete, non-empty `AgentContent`.
5. Write accepts one complete `AgentContent` and resolves with `void`.
6. Source failures reject without mandatory resource-layer wrapping.
7. Cancellation rejects with `name === "AbortError"`.
8. Write atomicity is not guaranteed by the common contract.
9. A resource is not retained across separate tool calls.
