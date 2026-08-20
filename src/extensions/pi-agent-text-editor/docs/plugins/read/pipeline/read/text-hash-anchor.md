# Line-hash text anchor extension

## Purpose

`pi-agent-text-anchor-line-hash` is an optional extension that owns the `LINE#HASH` format. It registers both:

- a major text anchor resolver with `pi-agent-text-editor`;
- a matching read prefix handler with `pi-agent-read`.

The editor core and read core do not know this syntax.

## Format

A line anchor is `${lineNumber}#${hash}`.

- line numbers are 1-based;
- the hash uses exact line content without its terminator;
- the hash is the first four uppercase hexadecimal characters of SHA-1;
- an empty line hashes as `DA39`.

The resolver handles only this pattern. It fails when the line does not exist or the current line hash differs. A mismatch is terminal because the resolver owns the format.

## Read presentation

For filesystem text, the read handler computes anchors before range projection and adds a neutral prefix:

```text
 9#ABCD|const value = config.timeout;
10#EF01|return value;
```

It pads anchors to the maximum width of the complete text snapshot. It does not attach a `FileAnchor` object or change canonical line content.

## Registration

The extension registers the resolver as:

```ts
api.addAnchorResolver({
  resolver: createLineHashAnchorResolver(),
  kind: TEXT_POSITION_ANCHOR_KIND,
  type: "major",
});
```

The resolver description explains the format in the editor system prompt. The read plugin description separately explains the visible read behavior.

A user may disable this extension or replace it with another major anchor extension without changing editor core.
