import type { LspClient } from "./client.js";
import { isMethodNotFound } from "./errors.js";
import type { LspPosition, LspRange } from "./types.js";

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}

export interface LspIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyResult {
  items: LspCallHierarchyItem[];
  incoming: LspIncomingCall[];
  outgoing: LspOutgoingCall[];
  /** Call directions the server does not implement, such as outgoing calls in clangd 18. */
  unsupported: LspCallDirection[];
}

export type LspCallDirection = "incoming" | "outgoing";

/** Resolve to undefined when the server does not implement the method. */
async function unlessUnsupported<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (isMethodNotFound(error)) return undefined;
    throw error;
  }
}

/** Load unopened TypeScript project files before a workspace-wide query when the server advertises support. */
export async function loadQueryProject(
  client: LspClient,
  uri: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!client.supportsCommand("typescript.tsserverRequest")) return;
  const project = await client.sendRequest<{ success?: boolean } | null>(
    "workspace/executeCommand",
    {
      command: "typescript.tsserverRequest",
      arguments: [
        "projectInfo",
        { file: client.serverDocumentPath(uri), needFileNameList: true },
        { isAsync: false, expectsResult: true },
      ],
    },
    signal,
  );
  signal?.throwIfAborted();
  if (project?.success !== true)
    throw new Error("TypeScript could not load the project for the workspace query.");
}
export async function requestReferences(
  client: LspClient,
  uri: string,
  position: LspPosition,
  signal?: AbortSignal,
): Promise<LspLocation[]> {
  await loadQueryProject(client, uri, signal);
  const result = await client.sendRequest<LspLocation[] | null>(
    "textDocument/references",
    {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    },
    signal,
  );
  return result ?? [];
}

export async function requestCallHierarchy(
  client: LspClient,
  uri: string,
  position: LspPosition,
  signal?: AbortSignal,
): Promise<LspCallHierarchyResult> {
  const items = await unlessUnsupported(
    client.sendRequest<LspCallHierarchyItem[] | null>(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri }, position },
      signal,
    ),
  );
  if (items === undefined)
    return { items: [], incoming: [], outgoing: [], unsupported: ["incoming", "outgoing"] };

  const firstItem = items?.[0];

  if (!firstItem) {
    return { items: [], incoming: [], outgoing: [], unsupported: [] };
  }

  const [incoming, outgoing] = await Promise.all([
    unlessUnsupported(
      client.sendRequest<LspIncomingCall[] | null>(
        "callHierarchy/incomingCalls",
        { item: firstItem },
        signal,
      ),
    ),
    unlessUnsupported(
      client.sendRequest<LspOutgoingCall[] | null>(
        "callHierarchy/outgoingCalls",
        { item: firstItem },
        signal,
      ),
    ),
  ]);

  return {
    items,
    incoming: incoming ?? [],
    outgoing: outgoing ?? [],
    unsupported: [
      ...(incoming === undefined ? (["incoming"] as const) : []),
      ...(outgoing === undefined ? (["outgoing"] as const) : []),
    ],
  };
}
