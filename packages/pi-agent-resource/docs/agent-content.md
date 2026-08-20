# Agent content contract

## Purpose

This document defines the content exchanged by `pi-agent-resource` resources.

The contract uses the content types that Pi already supports and adds one envelope for plugin-owned content. It does not define a second text or image representation.

## Public types

```ts
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface CustomContent {
  readonly type: "custom";
  readonly kind: string;
  readonly data: unknown;
}

export type AgentContentBlock = TextContent | ImageContent | CustomContent;

export type AgentContent = readonly [AgentContentBlock, ...AgentContentBlock[]];
```

`pi-agent-resource` re-exports `TextContent` and `ImageContent`. Consumers import the complete public content contract from `pi-agent-resource`.

Runtime shape validation is defined in [`runtime-validation.md`](./runtime-validation.md).

## AgentContent

`AgentContent` is an ordered, non-empty list of content blocks.

The order of blocks is significant. Text, images, and custom blocks may appear together and may repeat.

An empty resource is represented by a content block with an empty value, not by an empty block list. An empty text resource is:

```ts
[{ type: "text", text: "" }];
```

An empty array is not valid `AgentContent`.

A readable resource returns `AgentContent`. A writable resource accepts `AgentContent`.

## Pi content blocks

`TextContent` and `ImageContent` are the types exported by `@earendil-works/pi-ai`.

Pi currently accepts these two block types in an `AgentToolResult`:

```ts
type PiToolContent = TextContent | ImageContent;
```

Image data uses the Pi representation: a base64 string and a MIME type.

```ts
const image: ImageContent = {
  type: "image",
  data: "iVBORw0KGgoAAA...",
  mimeType: "image/png",
};
```

`pi-agent-resource` adds no alternate binary representation.

## CustomContent

`CustomContent` carries content understood by a source integration or another resource consumer but not directly supported by the current Pi tool-result boundary.

`type` is always `"custom"`.

`kind` is a non-empty string that identifies the custom content contract. The producer and the consumer own its meaning.

`data` is opaque to `pi-agent-resource`. Generic consumers do not inspect, stringify, or convert it automatically.

```ts
const chart: CustomContent = {
  type: "custom",
  kind: "chart",
  data: {
    series: [1, 2, 3],
  },
};
```

This package does not provide a custom-content registry. A consumer either understands a `kind`, transforms it through its own plugin pipeline, or applies its unsupported-content behavior.

## pi-agent-read projection

This section defines how `pi-agent-read` projects `AgentContent` to the current Pi `AgentToolResult` boundary. It does not change the original resource content contract.

Read plugins may transform custom blocks before this projection. After those transformations, `pi-agent-read` processes the remaining blocks in order:

1. `TextContent` is returned unchanged.
2. `ImageContent` is returned unchanged.
3. Each remaining `CustomContent` is replaced in the same position by a `TextContent` marker.

The marker format is:

```text
[unsupported_content_block kind=<kind> index=<index>]
```

`index` is the zero-based position of the custom block in the post-pipeline `AgentContent` list.

For example:

```ts
const source: AgentContent = [
  { type: "text", text: "Chart:" },
  { type: "custom", kind: "chart", data: { series: [1, 2, 3] } },
  { type: "image", data: "iVBORw0KGgoAAA...", mimeType: "image/png" },
];

const projected = [
  { type: "text", text: "Chart:" },
  { type: "text", text: "[unsupported_content_block kind=chart index=1]" },
  { type: "image", data: "iVBORw0KGgoAAA...", mimeType: "image/png" },
];
```

The marker is display text, not a machine-readable serialization of the custom block. `CustomContent.data` is never copied into the marker.

## Unsupported block details

`pi-agent-read` records every projected custom block in structured result details:

These detail types belong to `pi-agent-read`. They are not exported by `pi-agent-resource`.

```ts
export interface UnsupportedContentBlockDetail {
  readonly index: number;
  readonly kind: string;
}

export interface UnsupportedContentDetails {
  readonly unsupportedContentBlocks?: readonly [
    UnsupportedContentBlockDetail,
    ...UnsupportedContentBlockDetail[],
  ];
}
```

`unsupportedContentBlocks` is omitted when no block was projected. When present, it is non-empty and follows source order.

The structured detail is authoritative for programmatic use. It contains only `index` and `kind`. It never contains or serializes `CustomContent.data`.

## Fully unsupported content

If every source block is an unhandled `CustomContent`, `pi-agent-read` returns the generated text markers as a successful, non-empty result.

Unsupported projection alone does not mark the tool result as an error. Source resolution and reading succeeded; the markers describe the current consumer limitation.

## Invariants

1. `AgentContent` always contains at least one block.
2. Block order is preserved.
3. Core text and image blocks use the Pi types directly.
4. Image data is base64.
5. Custom data remains opaque unless a consumer explicitly understands its `kind`.
6. No generic path implicitly serializes custom data to text.
7. The Pi adapter replaces unsupported blocks in place instead of silently dropping them.
8. A result containing only unsupported markers is still a successful read.
