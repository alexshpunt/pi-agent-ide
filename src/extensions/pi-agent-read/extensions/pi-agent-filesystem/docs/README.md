# `pi-agent-filesystem`

## Purpose

`pi-agent-filesystem` provides unrestricted local filesystem access. It owns path recognition, filesystem I/O, Resource creation, and text replacement semantics.

It does not detect or convert concrete read formats. Installed adapter extensions choose the converters for each capability.

## Targets and resolvers

The extension creates two local content hosts and two resolver instances:

```text
filesystem/read -> read-only Resource -> pi-agent-read
filesystem/write -> read-write Resource -> pi-agent-text-editor
```

Both resolvers use the ID `filesystem`. The read and editor cores keep independent resolver registries.

Resolved filesystem Resources expose an absolute `file://` link for terminal navigation. Consumers use this link as presentation data and do not resolve filesystem paths themselves.

The separate targets prevent a readable derived format from becoming writable. Production adapters install:

```text
filesystem/read  <- image, pdf, text
filesystem/write <- text
```

## Source recognition

The resolvers handle ordinary host filesystem paths:

- relative paths;
- absolute paths;
- paths with dot-dot segments;
- platform drive paths.

An explicit reference with another scheme, such as `https:`, `symbol:`, or `internal:`, returns `not-handled`.

An empty source is a failed attempt. Resolution performs no filesystem read. A handled relative path is resolved against `context.cwd`, and the absolute path becomes `resource.source`.

## Read

A Resource read:

1. checks cancellation;
2. reads the complete file once as bytes;
3. passes the absolute source and bytes to its local content host;
4. returns the selected converter's non-empty AgentContent unchanged.

The provider does not inspect file suffixes, decode text, or classify images.

`pi-agent-filesystem-text` enables strict UTF-8 reads. `pi-agent-filesystem-image` enables JPEG, static PNG, GIF, WebP, and BMP image reads through `pi-agent-image`. `pi-agent-filesystem-pdf` enables page-oriented PDF text extraction through `pi-agent-pdf`.

The read resolver returns a Resource with `read` and no `write` callback.

## Write

The write resolver returns a read-write Resource because text mutation reads existing content before replacing it.

Its read callback uses only converters installed for `filesystem/write`. Production installs strict text and does not install image conversion.

The write callback accepts exactly one TextContent block and replaces the file contents with its text:

```ts
await resource.write([{ type: "text", text }], { signal });
```

Mixed, image, or custom content is rejected. The common Resource contract does not promise atomic writes.

## Path policy

`cwd` is only the base for a relative source:

- an absolute path remains absolute;
- dot-dot segments may escape `cwd`;
- paths outside the active project are valid;
- symlinks follow host filesystem behavior;
- no project-root or allowlist check is performed.

This extension is intentionally unrestricted. A user who needs another access policy installs a different source provider.

## Capability prompts

The provider registers lazy descriptions for both content hosts.

The read entry lists only converters installed for `filesystem/read`. The writable entry lists only converters installed for `filesystem/write` and appears only when a registered text-editor tool is selected. With the production adapters, read lists image, PDF, and text while write lists text only.

A provider entry is omitted when its matching host has no converter. The description reports installed behavior; it does not grant filesystem access, activate a converter, or change resolver selection.

## Registration

The provider connects its read resolver to `pi-agent-read` and its write resolver to `pi-agent-text-editor` through their public plugin protocols.

Content adapters connect through `pi-agent-resource`. Provider-first and adapter-first loading are both supported. Runtime conversion is a direct call against the provider-local host, not an event-bus request.

## Non-goals

This package does not:

- choose the user's enabled read formats;
- restrict paths or ask for confirmation;
- apply text ranges or editor anchors;
- implement mutation algorithms;
- invoke formatters, LSP, AST, Git, or UI behavior;
- reconcile conflicts with another filesystem provider.
