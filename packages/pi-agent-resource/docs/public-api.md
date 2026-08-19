# Public API contract

## Purpose

This document defines the public module surface of `pi-agent-resource`.

All consumers use one package-root import. Source file layout is an implementation detail.

## Package root

The only public module is:

```ts
"pi-agent-resource";
```

The package exports no public subpaths. Imports such as these are unsupported:

```ts
import type { AgentContent } from "pi-agent-resource/content";
import type { Resource } from "pi-agent-resource/resource";
import { isResource } from "pi-agent-resource/validation";
```

The implementation may use internal content, resource, resolver, and validation modules. Consumers do not import those files directly.

## Public type exports

The package root exports the shared content model, content conversion contracts, Resource contracts, and resolver contracts:

```ts
export type {
    AgentContent,
    AgentContentBlock,
    ContentCapability,
    ContentConversionAttempt,
    ContentConversionContext,
    ContentConverter,
    ContentConverterRegistration,
    ContentConverterRegistrationRequest,
    ContentDescription,
    ContentHost,
    ContentHostReady,
    ContentInput,
    ContentRunner,
    ContentTarget,
    CustomContent,
    ImageContent,
    ReadableResource,
    ReadWriteResource,
    Resource,
    ResourceBase,
    ResourceOperationContext,
    ResourceRead,
    ResourceResolutionAttempt,
    ResourceResolver,
    ResourceResolverContext,
    ResourceTryResolve,
    ResourceWrite,
    TextContent,
    WritableResource,
};
```

The exact contracts are specified in:

- [`agent-content.md`](./agent-content.md);
- [`content-conversion.md`](./content-conversion.md);
- [`resource.md`](./resource.md);
- [`resolver.md`](./resolver.md).

## Public value exports

The package root exports Resource guards and the complete content conversion runtime API:

```ts
export {
    connectContentConverter,
    CONTENT_API_VERSION,
    CONTENT_CONVERTER_REGISTER_EVENT,
    CONTENT_HOST_READY_EVENT,
    CONTENT_PROTOCOL,
    createContentHost,
    createContentRunner,
    isAgentContent,
    isContentConversionAttempt,
    isContentConversionContext,
    isContentConverter,
    isContentConverterRegistration,
    isContentConverterRegistrationRequest,
    isContentHostReady,
    isContentInput,
    isContentTarget,
    isResource,
    isResourceResolutionAttempt,
    isResourceResolver,
    renderContentDescription,
    targetsEqual,
    UnsupportedContentError,
};
```

Resource guard behavior is specified in [`runtime-validation.md`](./runtime-validation.md). Content conversion behavior is specified in [`content-conversion.md`](./content-conversion.md).

## Import examples

Consumers import contracts and runtime behavior from the same root:

```ts
import { type ContentConverter, createContentHost, type ResourceResolver } from "pi-agent-resource";
```

A consumer may combine type and value imports in one declaration when its TypeScript configuration supports it.

## Excluded exports

The package root does not export:

- a default export;
- a namespace object;
- public subpath modules;
- resolver registries;
- concrete resolvers, resources, or content converters;
- validation schemas;
- assertion functions or a common validation error;
- `pi-agent-read` unsupported-content detail types.

`UnsupportedContentBlockDetail` and `UnsupportedContentDetails` belong to the `pi-agent-read` result contract. They are not part of `pi-agent-resource`.

## Package exports map

The package exports map exposes only `.` for JavaScript and TypeScript consumers.

Internal build paths may change without creating a public subpath contract. A deep import is unsupported even when a built file is physically reachable.

## Invariants

1. Every supported import starts at `pi-agent-resource`.
2. The package root exports the complete Resource and content conversion contracts.
3. The package root exports the runtime guards and content conversion operations.
4. Pi text and image types remain direct type re-exports.
5. Content converter registration uses the package-owned protocol constants.
6. There is no default export or public subpath.
7. Internal file layout is not public API.
