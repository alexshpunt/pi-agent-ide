import type { LspClient } from "./client.js";
import type { LspPosition, LspRange } from "./types.js";

export interface LspLocation
{
    uri: string;
    range: LspRange;
}

export interface LspCallHierarchyItem
{
    name: string;
    kind: number;
    uri: string;
    range: LspRange;
    selectionRange: LspRange;
    detail?: string;
}

export interface LspIncomingCall
{
    from: LspCallHierarchyItem;
    fromRanges: LspRange[];
}

export interface LspOutgoingCall
{
    to: LspCallHierarchyItem;
    fromRanges: LspRange[];
}

export interface LspCallHierarchyResult
{
    items: LspCallHierarchyItem[];
    incoming: LspIncomingCall[];
    outgoing: LspOutgoingCall[];
}

export async function requestReferences(
    client: LspClient,
    uri: string,
    position: LspPosition,
): Promise<LspLocation[]>
{
    const result = await client.sendRequest<LspLocation[] | null>("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
    });
    return result ?? [];
}

export async function requestCallHierarchy(
    client: LspClient,
    uri: string,
    position: LspPosition,
): Promise<LspCallHierarchyResult>
{
    const items = await client.sendRequest<LspCallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
        textDocument: { uri },
        position,
    });

    const firstItem = items?.[0];

    if (!firstItem)
    {
        return { items: [], incoming: [], outgoing: [] };
    }

    const [incoming, outgoing] = await Promise.all([
        client
            .sendRequest<LspIncomingCall[] | null>("callHierarchy/incomingCalls", { item: firstItem })
            .catch(() => []),
        client
            .sendRequest<LspOutgoingCall[] | null>("callHierarchy/outgoingCalls", { item: firstItem })
            .catch(() => []),
    ]);

    return {
        items,
        incoming: incoming ?? [],
        outgoing: outgoing ?? [],
    };
}
