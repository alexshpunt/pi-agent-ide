import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { TextEditPlan, TextPreEditState } from "pi-agent-text-editor/api/edit-pipeline";
import type { LspManagerProvider } from "./manager-provider.ts";
import { resolveLspRenameTarget } from "./lsp/code-views.ts";
import { withLspDocuments } from "./lsp/document-leases.ts";
import { retryWhileSourceChanges, sourceChanged } from "./lsp/source-changes.ts";
import { requestRename, type LspWorkspaceEdit } from "./lsp/rename.ts";
import type { LspClient } from "./lsp/client.ts";
import type { LspPosition } from "./lsp/types.ts";
import { documentUri } from "./lsp/document-uri.ts";
import { loadQueryProject } from "./lsp/navigation.ts";
import { diagnosticErrors, textInRange, withoutCorrectedNames } from "./lsp/corrected-names.ts";
import { clangCoverage, createClangReach, renameRefusal } from "./lsp/clang-coverage.ts";

/** The identifier that contains `position`, or an empty string. */
function identifierAt(content: string, position: LspPosition): string {
  const line = content.split("\n")[position.line] ?? "";
  for (const match of line.matchAll(/[\p{L}\p{N}_$]+/gu))
    if (match.index <= position.character && position.character < match.index + match[0].length)
      return match[0];
  return "";
}

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

/**
 * Prepare server rename edits for the shared guarded editor, never a textual rename fallback.
 * Another process may write a participant while the server answers; the rename is then planned
 * again on the current text, and a symbol that is gone fails as before.
 */
export function prepareSymbolRename(
  state: TextPreEditState,
  managerFor: LspManagerProvider,
): Promise<TextPreEditState | undefined> {
  return retryWhileSourceChanges(
    () => withLspDocuments(() => prepareRename(state, managerFor)),
    state.signal,
  );
}

async function prepareRename(
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
  const fileOf = (uri: string) => (uri.startsWith("ssh://") ? uri : fileURLToPath(uri));
  const errorsOf = diagnosticErrors(
    (uri) => manager.openFile(fileOf(uri), state.cwd, "symbols", state.signal),
    state.signal,
  );
  const oldNames = [target.name, identifierAt(target.content, target.position)];
  // clangd renames unopened files from its index; opened files become participants with edits
  // from a fresh parse.
  const reach = await createClangReach({
    manager,
    cwd: state.cwd,
    errorsOf,
    ...(state.signal && { signal: state.signal }),
  })(
    target.client,
    manager.languageId(path.extname(source)),
    // A selector can end with an overload signature; the name at the declaration has none.
    oldNames[1] || oldNames[0] || "",
  );
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
      throw sourceChanged("The rename source changed. Read the symbol again before retrying.");
    const opened = await manager.openFile(file, state.cwd, "symbols", state.signal);
    if (opened?.client !== target.client || opened.uri !== uri)
      throw new Error(
        "A rename participant has a different language server owner. No edits applied.",
      );
    if (target.client.documentContent(uri) !== snapshot.content)
      throw sourceChanged("A rename participant changed during synchronization. No edits applied.");
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
      throw sourceChanged(
        "A rename participant changed during the server request. No edits applied.",
      );
  }
  if (reach !== undefined) {
    const refusal = renameRefusal(
      await clangCoverage(reach, [target.uri, ...entries.keys()], errorsOf, fileOf),
      (file) => (file.startsWith("ssh://") ? file : path.relative(state.cwd, file)),
    );
    if (refusal !== undefined) throw new Error(refusal);
  }
  // Clang renames names it corrected from a misspelling; those places keep their own text.
  const files: TextEditPlan["files"][number][] = [];
  for (const [uri, serverEdits] of entries) {
    const before = snapshots.get(uri);
    if (!before)
      throw new Error("Rename discovered a new participant after preflight. No edits applied.");
    const edits = await withoutCorrectedNames(
      serverEdits,
      (edit) => ({
        uri,
        start: edit.range.start,
        text: textInRange(before.content, edit.range),
      }),
      oldNames,
      errorsOf,
    );
    if (edits.length === 0) continue;
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
