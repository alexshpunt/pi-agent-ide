import type { LspClient } from "./client.js";
import type { LspPosition, LspTextEdit } from "./types.js";

export interface LspDocumentChange {
  textDocument: { uri: string };
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: LspDocumentChange[];
}

/**
Request a rename edit set from a native LSP server.
*/
export async function requestRename(
  client: LspClient,
  uri: string,
  position: LspPosition,
  newName: string,
): Promise<LspWorkspaceEdit | null> {
  return await client.sendRequest<LspWorkspaceEdit | null>("textDocument/rename", {
    textDocument: { uri },
    position,
    newName,
  });
}

/**
Flatten both WorkspaceEdit representations into per-file text edits.
*/
export function workspaceEditEntries(
  edit: LspWorkspaceEdit,
): { uri: string; edits: LspTextEdit[] }[] {
  const entries = new Map<string, LspTextEdit[]>();

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    entries.set(uri, [...(entries.get(uri) ?? []), ...edits]);
  }

  for (const change of edit.documentChanges ?? []) {
    entries.set(change.textDocument.uri, [
      ...(entries.get(change.textDocument.uri) ?? []),
      ...change.edits,
    ]);
  }

  return [...entries].map(([uri, edits]) => ({ uri, edits }));
}
