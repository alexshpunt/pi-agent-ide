import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface CustomContent
{
    readonly type: "custom";
    readonly kind: string;
    readonly data: unknown;
}

export type AgentContentBlock = TextContent | ImageContent | CustomContent;

export type AgentContent = readonly [
    AgentContentBlock,
    ...AgentContentBlock[],
];
