import { NAVIGATION_TIMEOUT_MS } from "pi-agent-resource";
import type { LspClient } from "./client.ts";
import { isMethodNotFound } from "./errors.ts";
import { sourceChanged } from "./source-changes.ts";
import type { LspPosition, LspRange } from "./types.ts";

export { NAVIGATION_TIMEOUT_MS };

export async function withNavigationDeadline<T>(
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => {
    deadline.abort(
      Object.assign(
        new Error(
          `LSP search timed out after ${NAVIGATION_TIMEOUT_MS / 1000} s. Retry or search the text.`,
        ),
        { code: "LSP_NAVIGATION_TIMEOUT" },
      ),
    );
  }, NAVIGATION_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const result = await run(signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * A reference query asked clangd to include the declaration. An empty reply for a known
 * declaration cannot establish that the symbol has no references.
 */
export function requireReferenceReply(name: string, references: readonly LspLocation[]): void {
  if (references.length === 0)
    throw sourceChanged(
      `The language server returned no locations for "${name}", including its known declaration. Retry or search the text.`,
    );
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
