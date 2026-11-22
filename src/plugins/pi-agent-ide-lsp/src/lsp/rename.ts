import { ResponseError } from "vscode-jsonrpc/node";
import type { LspClient } from "./client.ts";
import { sourceChanged } from "./source-changes.ts";
import type { LspPosition, LspTextEdit } from "./types.ts";

export interface LspDocumentChange {
  textDocument: { uri: string; version?: number | null };
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
  signal?: AbortSignal,
): Promise<LspWorkspaceEdit | null> {
  try {
    return await client.sendRequest<LspWorkspaceEdit | null>(
      "textDocument/rename",
      { textDocument: { uri }, position, newName },
      signal,
    );
  } catch (error) {
    // clangd validates the edits against its current drafts after computing them. It uses
    // a generic error code, so recognize the refusal by its protocol message.
    if (error instanceof ResponseError && /^Files? must be saved first: /u.test(error.message))
      throw sourceChanged("The language server text changed during rename.");
    throw error;
  }
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
