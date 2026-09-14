import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { TextEditPlan, TextPreEditState } from "pi-agent-text-editor/api/edit-pipeline";
import type { LspManagerProvider } from "./code-view-resolvers.js";
import { resolveLspRenameTarget } from "./lsp/code-views.js";
import { requestRename } from "./lsp/rename.js";
import type { LspPosition } from "./lsp/types.js";

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
  const target = await resolveLspRenameTarget(
    await managerFor(state.cwd),
    source,
    reference.selector,
    state.cwd,
    state.signal,
  );
  // TypeScript can answer rename before loading unopened project files.
  // Its advertised project query loads them before requesting workspace edits.
  if (target.client.supportsCommand("typescript.tsserverRequest")) {
    const project = await target.client.sendRequest<{ success?: boolean } | null>(
      "workspace/executeCommand",
      {
        command: "typescript.tsserverRequest",
        arguments: [
          "projectInfo",
          { file: source, needFileNameList: true },
          { isAsync: false, expectsResult: true },
        ],
      },
    );
    if (project?.success !== true)
      throw new Error("TypeScript could not load the project for rename. No edits applied.");
  }
  const requestedAt = Date.now();
  const edit = await requestRename(target.client, target.uri, target.position, input.text);
  state.signal?.throwIfAborted();
  if (edit === null)
    throw new Error(
      "The language server did not provide rename edits. No text fallback was applied.",
    );
  const entries = new Map(Object.entries(edit.changes ?? {}));
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change) || !("edits" in change))
      throw new Error("Rename returned a file operation that is not supported; no edits applied.");
    if (
      change.textDocument.version != null &&
      change.textDocument.version !== target.client.documentVersion(change.textDocument.uri)
    )
      throw new Error(
        "Rename refers to an unavailable document revision. Refresh the source before retrying.",
      );
    if (entries.has(change.textDocument.uri))
      throw new Error("Rename returned duplicate document edits.");
    entries.set(change.textDocument.uri, change.edits);
  }
  const files: TextEditPlan["files"][number][] = [];
  for (const [uri, edits] of entries) {
    const file = fileURLToPath(uri);
    const before = await stat(file);
    const content = await readFile(file, "utf8");
    const after = await stat(file);
    const synchronized = target.client.documentContent(uri);
    if (synchronized !== undefined && synchronized !== content)
      throw new Error(
        "The language server has stale text for a rename target. Read that symbol again before retrying.",
      );
    if (
      before.mtimeMs > requestedAt ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      (file === source && content !== target.content)
    )
      throw new Error(
        "A rename source changed during the language-server request. Retry from a fresh symbol read.",
      );
    files.push({
      source: file,
      expectedContent: content,
      changes: edits.map((change) => ({
        from: offset(content, change.range.start),
        to: offset(content, change.range.end),
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
