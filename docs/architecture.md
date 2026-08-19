# Architecture

Pi Agent IDE is an umbrella package around several independent Pi extensions and libraries. The package provides a ready-to-use default setup without turning those components into one tightly coupled implementation.

## One Pi extension, separate modules

The npm package exposes one Pi entrypoint:

```text
src/pi-agent-ide.ts
```

That entrypoint reads the user configuration and registers the enabled built-ins in a stable order. Pi sees one extension, so installation and configuration stay manageable.

The built-ins keep separate entrypoints, package manifests, tests, and public contracts. The composite loader changes how Pi starts them without removing their implementation boundaries.

The internal packages are bundled inside the umbrella tarball and are not published as separate registry packages. External extensions use public `pi-agent-ide/api/...` exports, which forward to the same bundled protocol implementations used by the built-ins.

## Main layers

```text
Pi Agent IDE
├── Resource and text libraries
├── read core
│   └── Resource resolvers, presenters, and pipeline handlers
├── search core
│   └── text, structural, semantic, and web resolvers
├── text-editor core
│   └── writable Resources, anchors, mutations, guards, and renderers
└── IDE core
    └── AST, LSP, formatter, lint, and Git-aware plugins
```

The cores do not import concrete plugins to discover behavior. Plugins connect through public protocols.

## Resources

A Resource gives a source an identity and optional read or write operations. Files, URLs, temporary snapshots, and derived views can use the same basic contract.

Read and write capabilities are explicit. The read core and text-editor core own separate resolver registries. A source that is safe to display is therefore not automatically available to mutation tools.

Shared Resource contracts live under `packages/pi-agent-resource`.

## Plugin protocols

The umbrella currently exposes four main extension protocols:

| Protocol package | Contributions |
| --- | --- |
| `pi-agent-read` | Resource resolvers, read handlers, presenters, result renderers |
| `pi-agent-search` | Search resolvers and search actions |
| `pi-agent-text-editor` | Writable resolvers, anchors, mutations, guards, renderers, edit listeners |
| `pi-agent-ide` | Formatter, compiler, linter, and other toolchain implementations |

Each plugin declares a protocol name, API version, stable ID, and `setup` function. Setup contributions are validated before they become active.

The core and plugin may load in either order. They exchange readiness and registration messages through Pi's shared event bus, then use direct in-memory APIs after registration. This lets an external Pi extension connect even though the built-in package is loaded through one composite entrypoint.

## Anchors

An anchor is an opaque value interpreted by a registered resolver. The text-editor core owns ordering and validation but does not hard-code every format.

An anchor resolver can:

- recognize a value;
- validate it against the current Resource snapshot;
- return a line or text selection;
- reject stale or ambiguous input with recovery context;
- resolve one anchor to several Resource sources.

Read presenters can display matching markers without changing canonical source text.

## Toolchain feedback

IDE plugins contribute formatters, compilers, and linters through the IDE protocol. Text-editor hooks use those contributions after a mutation has been prepared or applied.

This keeps mutation mechanics separate from language servers, formatter discovery, and repository-specific checks.

## Built-in selection

`src/composite/builtin-extensions.ts` is the built-in registry. Every entry has:

- a stable configuration ID;
- dependency IDs;
- its independent registration function.

The loader enables everything by default. When a core is disabled, built-ins that depend on it are disabled as well. External extensions are not controlled by this registry.

See [configuration](./configuration.md) for the user-facing settings.

## Development boundary

The composite entrypoint is a packaging and loading boundary, not permission to introduce hidden coupling between modules. New behavior should normally:

1. implement the smallest relevant public contract;
2. connect through the owning protocol;
3. keep source-specific logic outside the core;
4. include executable behavior coverage near that component.

See [writing extensions](./extensions.md) for practical examples and [development](./development.md) for the two loading modes.
