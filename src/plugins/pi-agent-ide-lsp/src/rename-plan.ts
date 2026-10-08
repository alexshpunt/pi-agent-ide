import { fileURLToPath } from "node:url";
import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { TextEditPlan, TextPreEditState } from "pi-agent-text-editor/api/edit-pipeline";
import type { LspManagerProvider } from "./code-view-resolvers.js";
import { resolveLspRenameTarget } from "./lsp/code-views.js";
import { requestRename, type LspWorkspaceEdit } from "./lsp/rename.js";
import type { LspClient } from "./lsp/client.js";
import type { LspPosition } from "./lsp/types.js";
import { documentUri } from "./lsp/document-uri.js";
import { loadQueryProject } from "./lsp/navigation.js";

function renameEntries(edit: LspWorkspaceEdit | null, client: LspClient) {
  if (edit === null)
    throw new Error(
      "The language server did not provide rename edits. No text fallback was applied.",
    );
  const entries = new Map(Object.entries(edit.changes ?? {}));
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change) || !("edits" in change))
      throw new Error("Rename returned an unsupported file operation. No edits applied.");
    if (
      change.textDocument.version != null &&
      change.textDocument.version !== client.documentVersion(change.textDocument.uri)
    )
      throw new Error("Rename refers to an unavailable document revision. No edits applied.");
    if (entries.has(change.textDocument.uri))
      throw new Error("Rename returned duplicate document edits.");
    entries.set(change.textDocument.uri, change.edits);
  }
  return entries;
}
function offset(content: string, position: LspPosition): number {
  const lines = content.split("\n");
  const line = lines[position.line];
  if (
    !Number.isInteger(position.line) ||
    position.line < 0 ||
    line === undefined ||
    !Number.isInteger(position.character) ||
    position.character < 0 ||
    position.character > line.replace(/\r$/u, "").length
  )
    throw new Error("The language server returned an invalid text position.");
  return (
    lines.slice(0, position.line).reduce((total, value) => total + value.length + 1, 0) +
    position.character
  );
}

/** Prepare server rename edits for the shared guarded editor, never a textual rename fallback. */
export async function prepareSymbolRename(
  state: TextPreEditState,
  managerFor: LspManagerProvider,
): Promise<TextPreEditState | undefined> {
  const input = state.input as Record<string, unknown>;
  if (
    typeof input.path !== "string" ||
    !input.path.startsWith("symbol:") ||
    !input.path.endsWith("#name")
  )
    return undefined;
  if (
    typeof input.text !== "string" ||
    input.text.trim() === "" ||
    input.start !== undefined ||
    input.end !== undefined
  )
    throw new Error(
      "Rename needs a symbol #name path and a non-empty new name in text, without start/end.",
    );
  const reference = parseCodeViewReference(input.path.slice(0, -5), "symbol");
  if (reference?.selector === undefined)
    throw new Error("Rename needs an exact symbol selector before #name.");
  const source = resolveCodeViewPath(reference.path, state.cwd);
  const manager = await managerFor(state.cwd, source, state.signal);
  const target = await resolveLspRenameTarget(
    manager,
    source,
    reference.selector,
    state.cwd,
    state.signal,
  );
  await loadQueryProject(target.client, target.uri, state.signal);
  // The first request discovers participants; only the second request can supply applied edits.
  // Capture and synchronize every participant first, so unopened files have a guarded revision.
  const preview = renameEntries(
    await requestRename(target.client, target.uri, target.position, input.text),
    target.client,
  );
  const snapshots = new Map<string, { file: string; content: string; version: string }>();
  for (const uri of new Set([target.uri, ...preview.keys()])) {
    state.signal?.throwIfAborted();
    const canonical = documentUri(uri, target.client.rootUri);
    if (canonical !== uri)
      throw new Error("Rename returned a non-canonical participant. No edits applied.");
    const file = canonical.startsWith("ssh://") ? canonical : fileURLToPath(canonical);
    const snapshot = await manager.readSourceSnapshot(file, state.signal);
    if (file === source && snapshot.content !== target.content)
      throw new Error("The rename source changed. Read the symbol again before retrying.");
    const opened = await manager.openFile(file, state.cwd, "symbols", state.signal);
    if (opened?.client !== target.client || opened.uri !== uri)
      throw new Error(
        "A rename participant has a different language server owner. No edits applied.",
      );
    if (target.client.documentContent(uri) !== snapshot.content)
      throw new Error("A rename participant changed during synchronization. No edits applied.");
    snapshots.set(uri, { file, ...snapshot });
  }
  const entries = renameEntries(
    await requestRename(target.client, target.uri, target.position, input.text),
    target.client,
  );
  state.signal?.throwIfAborted();
  for (const [uri, before] of snapshots) {
    state.signal?.throwIfAborted();
    const after = await manager.readSourceSnapshot(before.file, state.signal);
    if (before.version !== after.version || target.client.documentContent(uri) !== before.content)
      throw new Error("A rename participant changed during the server request. No edits applied.");
  }
  const files: TextEditPlan["files"][number][] = [];
  for (const [uri, edits] of entries) {
    const before = snapshots.get(uri);
    if (!before)
      throw new Error("Rename discovered a new participant after preflight. No edits applied.");
    files.push({
      source: before.file,
      expectedContent: before.content,
      changes: edits.map((change) => ({
        from: offset(before.content, change.range.start),
        to: offset(before.content, change.range.end),
        insert: change.newText,
      })),
    });
  }
  return {
    ...state,
    editPlan: { files },
    metadata: {
      ...state.metadata,
      semanticEdit: { mode: "lsp-rename", server: target.client.serverId, referencesUpdated: true },
      diffStatuses: [{ text: "Renamed through LSP", tone: "success" }],
    },
  };
}
