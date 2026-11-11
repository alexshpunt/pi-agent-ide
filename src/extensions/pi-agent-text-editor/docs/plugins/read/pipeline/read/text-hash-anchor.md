# Line anchor text extension

## Purpose

`pi-agent-text-anchor-line-hash` is an optional extension that owns the line-anchor format. It registers both:

- a major text anchor resolver with `pi-agent-text-editor`;
- a matching read prefix handler with `pi-agent-read`.

The editor core and read core do not know this syntax.

## Format

A line anchor is one token of seven characters from the alphabet `0-9A-HJKMNP-TV-Z` (35 bits), for example `K7M2QX4`. The token is computed from the current text of the whole file in one pass; no map is stored.

- A line whose text occurs once in the file is named by a hash of that text alone. Its anchor stays valid however the file shifts, until the line itself changes or a copy of it appears.
- A repeated line is named by a hash of its landmark (the nearest unique line above or below it), the number of times its text occurs between the landmark and the line, and its text. The anchor stays valid after any change outside the stretch between the landmark and the line, except a copy of its text added or removed on the other side (see below).
- The landmark comes from the line's own block, so moving or deleting a neighbouring block leaves the anchor valid. A column-0 `}` or `};` ends a block. The side whose nearest unique line is reached without crossing a block end is used; when both or neither are, the nearer side, above on a tie. So `template <typename T>` is named by the declaration below it, and a closing `}` by the line above it.
- The hash of a repeated line also includes the number of times its text occurs on the other side, up to the nearest unique line there, but not which line that is. When a copy of the text is inserted or removed on either side, the anchor fails instead of naming a neighbouring copy; moving a neighbouring block still leaves it valid.
- When no unique line is on a side, the edge of the file stands in. In a file of identical lines the anchor is in effect the line's position counted from both ends, so an inserted or removed copy makes it fail.
- A blank (whitespace-only) repeated line is named by its landmarks on both sides, each with its occurrence count. When a neighbouring block moves, the anchor of a blank line next to it either still names the same line or fails; it never matches a blank line next to the block in its new place.

Lines are split as Read splits them: a line has no terminator, and a final line terminator does not add an empty line.

The resolver handles only values of this shape. It fails when no line of the current file produces the anchor, and when several lines do; the second failure lists the candidates. A failure is terminal because the resolver owns the format.

## Read presentation

For filesystem text, the read handler computes anchors before range projection and adds a neutral prefix:

```text
K7M2QX4|const value = config.timeout;
B4NR9T2|return value;
```

Every anchor has the same width, so no padding is needed. The handler derives each anchor from the complete text snapshot, not from the window being shown. It does not attach a `FileAnchor` object or change canonical line content.

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
