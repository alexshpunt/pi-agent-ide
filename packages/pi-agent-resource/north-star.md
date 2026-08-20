# North Star: `pi-agent-resource`

> Status: implemented. Exact TypeScript contracts are defined in `docs/`.

## Thesis

`pi-agent-resource` defines the shared contracts for resolving and accessing agent-native resources used by Pi agent capabilities. It also owns the content model exchanged through those resources and the content conversion runtime used by source providers.

A source integration implements one resource model for its domain. Agent-facing capabilities such as reading and text editing consume that model instead of defining source-specific I/O contracts.

The package provides contracts, runtime guards, and target-local content conversion. It does not provide a Pi extension, a resolver registry, a concrete resource implementation, or a concrete content converter.

## Vocabulary

A **source reference** is an opaque string supplied by a caller. It may be a local path, URI, remote key, or another identifier.

A **resource resolver** decides whether it owns a source reference and may resolve it to a resource.

A **resource** represents access to one resolved source. It exposes the I/O capabilities that the source supports.

**Agent-native content** is the package-owned content model exchanged by resource operations. Every consumer uses the same content types instead of defining a private read or edit payload.

A **capability** is an operation that can be performed on a resource. The common capabilities are reading and writing.

## Resource capabilities

A resource exposes reading, writing, or both. Read-only, write-only, and read-write resources are all valid.

Read and write are the only common capability names. The source integration owns the exact behavior of its write operation. A filesystem resource may replace stored content, while a write-only log may append it.

Every resource exposes at least one capability. A resource with no usable operation is invalid.

Consumers check for the capability they need and do not infer access from a source reference, resolver name, content type, or provider kind.

The public `Resource` contract uses a structural union of read-only, write-only, and read-write shapes. Operation presence is the only capability declaration. The exact contract is defined in [`docs/resource.md`](./docs/resource.md).

## Agent-native content

Readable resources return the agent-native content model defined by this package. Writable resources accept that same shared model.

The first contract re-exports Pi `TextContent` and `ImageContent` and adds tagged `CustomContent`. Mixed content and future plugin-owned representations use one package surface without duplicating Pi's existing types.

A source integration maps between its source representation and agent-native content. `pi-agent-read`, `pi-agent-text-editor`, and other consumers use this contract without redefining it. The exact content contract is defined in [`docs/agent-content.md`](./docs/agent-content.md).

## Content conversion

A source provider reads bytes and gives them to a target-local `ContentHost`. Content converters map those bytes to the same `AgentContent` model used by Resource operations.

Hosts and adapter extensions register through the `pi-agent-resource/content-conversion` Pi event protocol. Runtime conversion calls stay local to the host. The package owns ordering, validation, descriptions, and unsupported-content behavior, while `pi-agent-text`, `pi-agent-image`, and provider-local adapters own concrete formats.

The exact conversion behavior is defined in [`docs/content-conversion.md`](./docs/content-conversion.md).

## Resolution

Every source integration uses the common `ResourceResolver` contract. It does not invent a read resolver, write resolver, or editor-specific resolver type. The exact contract is defined in [`docs/resolver.md`](./docs/resolver.md).

Resolution distinguishes three outcomes:

- the resolver does not own the source reference;
- the resolver resolved a resource;
- the resolver owns the source reference but resolution failed.

A resolver reports "not handled" only when the source is outside its domain. A recognized source that is denied, unavailable, or invalid fails explicitly so a less restrictive fallback cannot silently bypass that result.

## Resource lifetime

A resolved resource belongs to one resolution and one consuming operation. A later tool call resolves the source again instead of retaining the previous resource as shared identity.

The common contract provides no resource cache or long-lived cleanup lifecycle. A source integration finishes any operation-local cleanup before its work returns.

## Write routing

A writable resource performs its own write operation. A consumer writes through that resource instead of looking up a separate callback by resource type.

The implemented model has no parallel type-based writer registry. The removed model appears only in the completed migration record.

## Ownership

`pi-agent-resource` owns:

- the shared resource vocabulary;
- the agent-native content interfaces and types;
- resource and resolver contracts;
- read and write capability invariants;
- source-neutral resolution outcomes;
- content converter contracts and runtime guards;
- target-local converter ordering and execution;
- the content conversion registration protocol;
- structural runtime guards for all shared values.

A consuming capability core owns:

- its resolver registry;
- registration and lifecycle rules;
- resolver ordering and selection;
- the way resource failures become capability failures;
- the agent-facing behavior and transformations built on top of a resource.

A source integration owns:

- source recognition;
- authorization and access policy;
- concrete Resource creation;
- source-specific I/O and write mapping;
- delegation of read bytes to installed content converters;
- source-specific failures.

## Package relationships

`pi-agent-filesystem` implements local filesystem Resources and capability-specific resolvers. A secure filesystem, remote filesystem, memory store, or another source provider implements the same contracts without changing `pi-agent-read` or `pi-agent-text-editor`.

`pi-agent-read` consumes readable resources. It owns the agent-facing read tool, pipeline, projection, and result presentation, but not the resource content types.

`pi-agent-text-editor` consumes readable and writable resources that contain text. It owns text mutation, anchors, history, and editor behavior, then persists the result through the resource write operation.

A source provider may connect one resolver implementation or separate capability-specific resolvers to capability cores. Each core owns its registry; the shared resolver and Resource contracts remain the same.

## User choice

This package ships no default resolver or content converter and grants no access by itself.

The loaded source extensions determine which concrete resources are available. A user may choose unrestricted local filesystem access, a secure filesystem, remote resources, or any combination. Resolver priority and conflict handling belong to the core that accepts those resolvers.

Independent capability registries may resolve the same source reference differently. This is user configuration, not a conflict that `pi-agent-resource` reconciles. A user who combines secure and unrestricted integrations accepts the resulting access model; otherwise they should load one coherent integration or provide their own.

## Pi boundary

The package uses Pi events only for the content conversion host and adapter handshake. Runtime conversion is direct, and Resource resolver registration remains owned by each capability core. Pi does not provide a generic I/O resource contract or resource resolver registry.

`resources_discover` is for discovering Pi resources such as skills, prompts, and themes. It is not a source I/O abstraction.

## Runtime boundary

Plugin-supplied Resource and content conversion values are checked with package-owned structural guards before use. The guards accept extension-owned fields, do not invoke callbacks, and leave failure presentation to the consuming core or content host. Invalid resolver and converter output is terminal. Exact Resource guard behavior is defined in [`docs/runtime-validation.md`](./docs/runtime-validation.md).

## Public surface

All public Resource and content conversion contracts are exported from the `pi-agent-resource` package root. There are no public subpath modules. The exact export list is defined in [`docs/public-api.md`](./docs/public-api.md).

## Invariants

1. A resource exposes at least one of read or write.
2. Read-only, write-only, and read-write resources are first-class cases.
3. Read and write are the only common capability names.
4. All resource operations exchange the package-owned agent-native content model.
5. Consumers use only capabilities exposed by the resolved resource.
6. A writable resource performs its own write; there is no separate writer lookup.
7. Source integrations use the common resolver contract rather than capability-specific resolver types.
8. A resolved resource is not shared across separate tool calls.
9. The contracts contain no filesystem, editor, or specific agent-tool assumptions.
10. The package creates no process-global Resource or converter registry.
11. Contract values do not rely on shared class identity across independently loaded package roots.
12. Authorization failure cannot be represented as `not-handled` to enable fallback.
13. Plugin-supplied common values pass package-owned structural guards before use.
14. Each content host owns converters for one exact provider and capability target.
15. Converter ordering is deterministic and stable.
16. Converter failure, invalid output, and unsupported content are terminal.
17. Pi events are used only for content converter registration.
18. Every supported public import uses the package root.

## Non-goals

`pi-agent-resource` does not define:

- agent tools or tool schemas;
- public validation schemas or a shared validation error;
- read or edit pipelines;
- resolver ordering policy;
- consistency or policy enforcement across independent resolver registries;
- concrete storage access;
- concrete text, HTML, image, or document conversion;
- text anchors, edits, or commit history;
- cross-call resource caching or a shared cleanup lifecycle.

## Migration

The package-specific source access and writer routing contracts were replaced atomically. Content conversion was later merged into the same package because every converter and provider already shared the Resource content model. The original source-access cutover is recorded in [`docs/migration.md`](./docs/migration.md).
