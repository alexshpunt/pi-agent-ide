# Resource contract migration

> Status: completed. This document records the atomic cutover and its acceptance criteria.

> Current source-provider and content-conversion architecture is defined in [`docs/domain/pi-agent`](/docs/domain/pi-agent/README.md). The historical filesystem examples below are not the current provider API.

## Purpose

This document defines the atomic migration from package-specific read and write routing to `pi-agent-resource` contracts.

The migration covers:

- `pi-agent-resource`;
- `pi-agent-read`;
- `pi-agent-text-editor`;
- `pi-agent-filesystem`;
- their package-local and shared domain documentation;
- tests that exercise the replaced contracts.

There is no compatibility period, adapter layer, deprecated alias, or permanent dual API.

## Target dependency direction

```text
pi-agent-read        -> pi-agent-resource
pi-agent-text-editor -> pi-agent-resource
pi-agent-filesystem  -> pi-agent-resource
pi-agent-filesystem  -> pi-agent-read plugin protocol
pi-agent-filesystem  -> pi-agent-text-editor plugin protocol
```

`pi-agent-text-editor` may continue to depend on `pi-agent-read` for its read-pipeline integrations. Neither capability core imports `pi-agent-filesystem`.

## Target source integration

One source extension creates one stable ResourceResolver object and registers it with every capability core it supports.

```ts
const resolver = createFilesystemResolver();

const readPlugin = {
    setup(api)
    {
        api.addResolver({ resolver });
    },
};

const editorPlugin = {
    setup(api)
    {
        api.addResolver({ resolver });
    },
};
```

The resolver object is shared. The registries are not shared. Each core owns its registration order, priority, snapshots, failures, and lifecycle.

Registration into one core does not imply successful registration into another core.

## Capability mismatch

A core checks the selected Resource after resolution.

If the Resource does not expose an operation required by the current capability, the core returns terminal `UNSUPPORTED_CAPABILITY` failure.

The core does not continue to a later resolver. Resolver ownership has already been established, and fallback could bypass a read-only or secure source implementation.

Examples:

- `pi-agent-read` requires `read`;
- an editor operation that mutates existing text requires `read` and `write`;
- a future write-only operation requires only `write`.

A missing capability is not `not-handled` and does not change the resolver outcome.

## pi-agent-resource

The package becomes the public owner of:

- `AgentContent`, `AgentContentBlock`, and `CustomContent`;
- re-exported Pi `TextContent` and `ImageContent`;
- Resource operation and Resource union types;
- ResourceResolver context, attempt, and resolver types;
- `isAgentContent`, `isResource`, `isResourceResolver`, and `isResourceResolutionAttempt`.

The implementation follows:

- [`agent-content.md`](./agent-content.md);
- [`resource.md`](./resource.md);
- [`resolver.md`](./resolver.md);
- [`runtime-validation.md`](./runtime-validation.md);
- [`public-api.md`](./public-api.md).

The package root is the only public module. No read-core, editor-core, filesystem, registration, or pipeline behavior moves into this package.

The package adds `typebox` as a direct runtime dependency. TypeBox schemas remain private implementation details.

## pi-agent-read

`pi-agent-read` removes its package-specific source I/O contracts:

- `ReadAgentContent`;
- `ResolvedRead`;
- `ReadResolverContext`;
- `ReadResolveAttempt`;
- `ReadResolver`.

Its resolver registration API accepts the shared `ResourceResolver` contract.
The core calls `isResourceResolver` before registration and rejects an invalid resolver.

The read execution flow becomes:

1. run pre-read handlers;
2. call registered ResourceResolvers in core-owned order;
3. validate every fulfilled attempt with `isResourceResolutionAttempt`;
4. continue only after `not-handled` and stop on `resolved` or `failed`;
5. verify that the resolved Resource exposes `read`;
6. call `resource.read({ signal })`;
7. validate the fulfilled value with `isAgentContent`;
8. create read state from `resource.source` and returned `AgentContent`;
9. run read handlers and text projection;
10. project remaining custom blocks according to [`agent-content.md`](./agent-content.md);
11. run post-read handlers and return the agent-facing result.

A malformed fulfilled attempt or read value is a terminal read-core contract failure as defined in [`runtime-validation.md`](./runtime-validation.md).

A source error from `resource.read()` is mapped to the existing read-core failure boundary with source and resolver context.

Read-core continues to own:

- resolver priority and stable order;
- pipeline state and handlers;
- content classification;
- line projection;
- truncation and presentation;
- agent-facing failure codes.

## pi-agent-text-editor

`pi-agent-text-editor` removes:

- `TextResourceType`;
- `TextCommit`;
- `TextCommitter`;
- `TextEditorPluginApi.addCommitter()`;
- `TextEditorCore.commitText()`;
- the committer map and committer validation.

The editor plugin API gains resolver registration using the shared ResourceResolver contract. The editor core owns an independent resolver registry with deterministic priority and stable order.

The core calls `isResourceResolver` before registration and rejects an invalid resolver.

An editor operation resolves its source through that registry. A mutation of existing text:

1. resolves one Resource and validates every fulfilled attempt with `isResourceResolutionAttempt`;
2. requires both `read` and `write`;
3. reads `AgentContent`;
4. validates the fulfilled read value with `isAgentContent`;
5. accepts the text representation required by that editor operation;
6. applies the in-memory mutation;
7. validates the final content with `isAgentContent`;
8. writes the final `AgentContent` through the same Resource object.

A malformed fulfilled attempt, read value, or write input is a terminal editor-core contract failure as defined in [`runtime-validation.md`](./runtime-validation.md).

The editor does not route writes through a type string or a second callback lookup.

The existing edit pipeline remains editor-owned and wraps the mutation operation as before.

## pi-agent-filesystem

`pi-agent-filesystem` replaces `createFilesystemReadResolver()` with one shared `createFilesystemResolver()`.

The filesystem resolver:

- implements `ResourceResolver`;
- canonicalizes a source against `context.cwd`;
- returns a Resource whose `source` is the absolute path;
- exposes filesystem read and write operations;
- uses operation signals for abort-aware filesystem calls;
- returns source errors without read-core wrappers.

Resolution no longer reads file content. Reading happens only through `resource.read()`.

The unrestricted filesystem integration returns a read-write Resource. Its read operation produces non-empty text `AgentContent`. Its write operation persists the supplied filesystem content using filesystem-owned semantics.

The extension entrypoint creates the resolver once and connects it to both read and text-editor plugin protocols.

Its package dependencies add `pi-agent-resource` and `pi-agent-text-editor` alongside `pi-agent-read`.

## Removed routing model

The migration deletes the `resourceType + TextCommitter` model from code and current documentation.

There is no compatibility alias for resource types and no adapter that converts a committer into a writable Resource.

A writable Resource is the only write-routing mechanism after the migration.

## Documentation migration

Package-local documentation is updated with the implemented shared contracts.

Shared domain documents that describe text committer routing are deleted or rewritten. Current documentation must not describe both models as valid alternatives.

Historical documents under an explicit legacy area may remain only when they are already treated as history and are not linked as current architecture.

## Test migration

Tests that construct package-specific read resolvers use shared ResourceResolvers and Resources.

Committer routing tests are removed or rewritten around editor resolver registration and Resource.write().

Existing integration coverage is updated to verify the replaced behavior, including:

- core-first and plugin-first resolver registration;
- rejection of a malformed resolver;
- read through a readable Resource;
- terminal failure for malformed resolver output or read content;
- terminal failure for a Resource without `read`;
- editor read and write through the same Resource;
- terminal failure for a missing editor capability or malformed write input;
- one filesystem resolver object registered with both cores.

No compatibility tests are retained for deleted APIs.

## Execution order

The atomic change is implemented in this order inside one migration:

1. add the public `pi-agent-resource` implementation and exports;
2. migrate `pi-agent-read` to Resource resolution and reading;
3. replace text-editor committers with its resolver registry;
4. migrate `pi-agent-filesystem` and connect it to both cores;
5. update affected tests;
6. delete superseded contracts and code;
7. update package-local and shared domain documentation;
8. run the affected integration tests and repository checks.

Intermediate edits may be temporarily incomplete inside the working tree. The completed migration exposes only the new model.

## Completion criteria

The migration is complete when:

1. the package root exports the complete shared types and guards with no public subpaths;
2. all three consumer packages depend on `pi-agent-resource` where required;
3. read and editor accept the shared ResourceResolver type;
4. filesystem creates one resolver object and registers it with both cores;
5. read invokes Resource.read();
6. editor invokes Resource.read() and Resource.write() on the same resolved object;
7. both cores enforce the required runtime validation points;
8. missing capabilities and malformed resolver output fail without resolver fallback;
9. no active API exports or uses `ReadResolver`, `TextResourceType`, `TextCommitter`, or `commitText`;
10. current documentation describes only Resource-based routing;
11. affected tests and repository checks pass.
