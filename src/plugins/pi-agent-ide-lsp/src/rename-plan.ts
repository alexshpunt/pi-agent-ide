import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRangeTracker, ResourceError, type ResultTargetStore } from "pi-agent-resource";
import { type NameCapture, type NameCaptures, currentNameCapture } from "./name-captures.ts";
import type {
  TextEditPlan,
  TextEditPlanChange,
  TextPreEditState,
} from "pi-agent-text-editor/api/edit-pipeline";
import type { LspManagerProvider } from "./manager-provider.ts";
import { resolveLspRenameTarget } from "./lsp/code-views.ts";
import { withLspDocuments } from "./lsp/document-leases.ts";
import { SOURCE_CHANGED, sourceChanged } from "./lsp/source-changes.ts";
import { requestRename, type LspWorkspaceEdit } from "./lsp/rename.ts";
import type { LspClient } from "./lsp/client.ts";
import type { LspPosition, LspTextEdit } from "./lsp/types.ts";
import { documentUri } from "./lsp/document-uri.ts";
import { assertLspLines } from "./lsp/line-breaks.ts";
import { loadQueryProject } from "./lsp/navigation.ts";
import { diagnosticErrors, textInRange, withoutCorrectedNames } from "./lsp/corrected-names.ts";
import {
  CLANG_LANGUAGES,
  clangCoverage,
  createClangReach,
  renameRefusal,
} from "./lsp/clang-coverage.ts";

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
function offsets(content: string): (position: LspPosition) => number {
  // LSP lines equal the editor's LF-only lines unless the text holds a lone CR.
  assertLspLines(content);
  let start = 0;
  const lines = content.split("\n").map((line) => {
    const span = { start, length: line.replace(/\r$/u, "").length };
    start += line.length + 1;
    return span;
  });
  return ({ line, character }) => {
    const span = lines[line];
    if (
      !Number.isInteger(line) ||
      line < 0 ||
      span === undefined ||
      !Number.isInteger(character) ||
      character < 0 ||
      character > span.length
    )
      throw new Error("The language server returned an invalid text position.");
    return span.start + character;
  };
}

/** Match the same substantive lines in order. A range's spelling alone says nothing about lookup. */
function matchLayout(
  before: string,
  current: string,
  oldName: string,
  newName: string,
  allowIndentation: boolean,
) {
  const isTrivia = (line: string) =>
    /^[ \t]*\r?$/u.test(line) ||
    (/^[ \t]*\/\/[^\\@#\r]*\r?$/u.test(line) &&
      !line.includes("*/") &&
      !line.includes("??/") &&
      !line.includes(oldName) &&
      !line.includes(newName));
  const significantLines = (content: string) =>
    content.split("\n").flatMap((line, index) => {
      if (isTrivia(line)) return [];
      const text = line.replace(/^[ \t]*/u, "");
      return [{ index, text, indent: line.slice(0, line.length - text.length) }];
    });
  const old = significantLines(before);
  const next = significantLines(current);
  if (old.length !== next.length) return undefined;
  const lines = new Map<number, { line: number; shift: number }>();
  for (const [index, line] of old.entries()) {
    const moved = next[index];
    if (
      moved === undefined ||
      moved.text !== line.text ||
      (!allowIndentation && moved.indent !== line.indent)
    )
      return undefined;
    lines.set(line.index, { line: moved.index, shift: moved.indent.length - line.indent.length });
  }
  return lines;
}

function rebaseRename(
  before: string,
  current: string,
  edits: readonly LspTextEdit[],
  changes: readonly TextEditPlanChange[],
  oldName: string,
  newName: string,
  languageId: string,
): readonly TextEditPlanChange[] | undefined {
  if (!CLANG_LANGUAGES.has(languageId)) return undefined;
  // Comment-like text can be literal or part of a spliced line. Position-dependent builtins
  // can change the meaning of otherwise identical syntax when a line or column moves.
  const dependsOnLayout =
    /R"|__LINE__|__builtin_LINE|__builtin_COLUMN|source_location|##|%:%:|\?\?=\?\?=|(?:\\|\?\?\/)[ \t]*\r?\n/u;
  if (dependsOnLayout.test(before) || dependsOnLayout.test(current)) return undefined;
  const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
  if (!identifier.test(oldName) || !identifier.test(newName)) return undefined;

  // Macros from headers can read the column at their expansion site without spelling
  // the builtin in this file. Keep line-only tracking when preprocessing may be involved.
  const mayUseMacros = /#|%:|\?\?=|\bimport\b/u.test(before);
  const layout = matchLayout(before, current, oldName, newName, !mayUseMacros);
  if (layout === undefined) return undefined;
  const tracker = createRangeTracker(before, current);
  const offset = offsets(current);
  const remapped: TextEditPlanChange[] = [];
  for (const [
    index,
    {
      range: { start, end },
      newText,
    },
  ] of edits.entries()) {
    const original = changes[index];
    const expected = layout.get(start.line);
    if (
      original === undefined ||
      newText !== newName ||
      before.slice(original.from, original.to) !== oldName ||
      expected === undefined ||
      start.line !== end.line
    )
      return undefined;
    const moved = tracker.move({
      start: { lineNumber: start.line + 1, column: start.character },
      end: { lineNumber: end.line + 1, column: end.character },
    });
    const line = expected.line;
    if (
      moved === undefined ||
      moved.start.lineNumber !== line + 1 ||
      moved.end.lineNumber !== line + 1 ||
      moved.start.column !== start.character + expected.shift ||
      moved.end.column !== end.character + expected.shift
    )
      return undefined;
    const from = offset({ line, character: moved.start.column });
    const to = offset({ line, character: moved.end.column });
    if (current.slice(from, to) !== oldName) return undefined;
    remapped.push({ from, to, insert: newText });
  }
  return remapped;
}

const REFRESH_BUDGET_MS = 12_000;
const REFRESH_ATTEMPT_MS = 4_000;
// One extra attempt per pause, with breathing room for the server to see peer writes.
const REFRESH_DELAYS_MS = [0, 50, 100, 200, 400, 500, 500, 500, 500];
/** An immediate repeat of a contended selection is a refresh too, not another cold request. */
const contendedCaptures = new WeakSet<NameCapture>();

function sourceMoved(error: unknown): boolean {
  return (
    (error instanceof ResourceError && error.code === "RESOURCE_CHANGED") ||
    (error as { code?: unknown } | null)?.code === SOURCE_CHANGED
  );
}

/** Prepare native edits for the guarded editor; never fall back to a textual rename. */
export function prepareSymbolRename(
  state: TextPreEditState,
  managerFor: LspManagerProvider,
  captures: NameCaptures,
  resultTargets: ResultTargetStore,
): TextPreEditState | undefined {
  const started = performance.now();
  const input = state.input as Record<string, unknown>;
  const selected = captures.find(input);
  if (selected === undefined) return undefined;
  const capture = captures.get(input.path);
  let cached: TextEditPlan | undefined;
  let refreshDeadline: AbortSignal | undefined;

  function startRefresh(capture: NameCapture) {
    contendedCaptures.add(capture);
    return (refreshDeadline ??= AbortSignal.timeout(REFRESH_BUDGET_MS));
  }

  function exhaustedMessage() {
    const elapsed = ((performance.now() - started) / 1_000).toFixed(1);
    return `The rename could not catch up with newer text after ${elapsed} s. Nothing was written. Repeat the same replace call with the same name capture and new name.`;
  }
  return {
    ...state,
    ...(capture !== undefined && {
      sourceChangeRetry: {
        delaysMs: REFRESH_DELAYS_MS,
        start: () => startRefresh(capture),
        exhaustedMessage,
      },
    }),
    // Planning failures use the resolved file, not the opaque selection, as their source.
    input: { ...input, path: selected.capture.source },
    planEdit: async () => {
      if (
        capture === undefined ||
        typeof input.newText !== "string" ||
        input.newText.trim() === "" ||
        input.start !== undefined ||
        input.end !== undefined
      )
        throw new Error(
          "Rename needs one declaration name capture and a non-empty new name. " +
            "Omit start/end. Use replace with " +
            JSON.stringify({ path: selected.reference, newText: "newName" }),
        );
      state.signal?.throwIfAborted();
      const deadline = contendedCaptures.has(capture) ? startRefresh(capture) : undefined;
      if (deadline?.aborted) throw new Error(exhaustedMessage());
      if (cached !== undefined) return cached;
      const attempt = deadline === undefined ? undefined : AbortSignal.timeout(REFRESH_ATTEMPT_MS);
      const signal =
        attempt === undefined || deadline === undefined
          ? state.signal
          : AbortSignal.any([deadline, attempt, ...(state.signal ? [state.signal] : [])]);
      try {
        const request: RenameRequest = { ...capture, newName: input.newText };
        const plan = await withLspDocuments(() =>
          planRename(state.cwd, signal, request, managerFor, () =>
            currentNameCapture(resultTargets, input.path, state.cwd, signal),
          ),
        );
        signal?.throwIfAborted();
        cached = {
          files: plan.files.map((file) => ({
            ...file,
            rebase(current) {
              const mapped = file.rebase?.(current);
              if (mapped === undefined) {
                cached = undefined;
                startRefresh(capture);
              }
              return mapped;
            },
          })),
        };
        return cached;
      } catch (error) {
        state.signal?.throwIfAborted();
        if (deadline?.aborted) throw new Error(exhaustedMessage(), { cause: error });
        if (attempt?.aborted && error === attempt.reason)
          throw sourceChanged("The language server did not finish the rename refresh in time.");
        if (!sourceMoved(error)) throw error;
        startRefresh(capture);
        throw error;
      }
    },
    metadata: {
      ...state.metadata,
      semanticEdit: { mode: "lsp-rename", referencesUpdated: true },
      diffStatuses: [{ text: "Renamed through LSP", tone: "success" }],
    },
  };
}

interface RenameRequest {
  readonly source: string;
  readonly selector: readonly string[];
  readonly newName: string;
}

async function planRename(
  cwd: string,
  signal: AbortSignal | undefined,
  { source, selector, newName }: RenameRequest,
  managerFor: LspManagerProvider,
  capture: () => ReturnType<typeof currentNameCapture>,
): Promise<TextEditPlan> {
  const selected = await capture();
  const content = selected.target.expectedContent;
  if (selected.target.source !== source)
    throw new Error("The name capture no longer identifies this declaration. Repeat lsp_search.");
  const manager = await managerFor(cwd, source, signal);
  const target = await resolveLspRenameTarget(manager, source, selector, cwd, content, signal);
  // A capture from any redeclaration names the same symbol, but never a sibling overload.
  const entry = target.entries.find(
    ({ selectionRange: { start, end } }) =>
      selected.range.start.lineNumber === start.line + 1 &&
      selected.range.start.column === start.character &&
      selected.range.end.lineNumber === end.line + 1 &&
      selected.range.end.column === end.character,
  );
  if (entry === undefined)
    throw new Error("The name capture no longer identifies this declaration. Repeat lsp_search.");
  const position = entry.selectionRange.start;
  const fileOf = (uri: string) => (uri.startsWith("ssh://") ? uri : fileURLToPath(uri));
  const { client, uri: targetUri } = target;
  const snapshots = new Map([
    [targetUri, { file: source, content, version: client.documentVersion(targetUri) }],
  ]);
  function checkSnapshots() {
    signal?.throwIfAborted();
    for (const [uri, before] of snapshots) {
      if (
        client.documentVersion(uri) !== before.version ||
        client.documentContent(uri) !== before.content
      )
        throw sourceChanged(
          "A rename participant changed on the language server. No edits applied.",
        );
    }
  }
  const errorsOf = diagnosticErrors((uri) => {
    const snapshot = snapshots.get(uri);
    return manager.openFile(
      fileOf(uri),
      cwd,
      "symbols",
      signal,
      snapshot === undefined ? undefined : () => Promise.resolve(snapshot.content),
    );
  }, signal);
  await loadQueryProject(client, targetUri, signal);
  const oldNames = [entry.name, identifierAt(target.content, position)];
  // clangd renames unopened files from its index; opened files become participants with edits
  // from a fresh parse.
  const reach = await createClangReach({
    manager,
    cwd,
    errorsOf,
    ...(signal && { signal: signal }),
  })(
    target.client,
    manager.languageId(path.extname(source)),
    // A selector can end with an overload signature; the name at the declaration has none.
    oldNames[1] || oldNames[0] || "",
  );
  // The server answers for these snapshots, not for whatever is on disk when it finishes.
  // If an indexed file also needs edits, synchronize it before asking for its final ranges.
  async function renameOnSnapshots() {
    checkSnapshots();
    const edit = await requestRename(client, targetUri, position, newName, signal);
    checkSnapshots();
    return renameEntries(edit, client);
  }
  const preview = await renameOnSnapshots();
  for (const uri of preview.keys()) {
    if (uri === targetUri) continue;
    signal?.throwIfAborted();
    const canonical = documentUri(uri, client.rootUri);
    if (canonical !== uri)
      throw new Error("Rename returned a non-canonical participant. No edits applied.");
    const file = fileOf(uri);
    const { content } = await manager.readSourceSnapshot(file, signal);
    const opened = await manager.openFile(file, cwd, "symbols", signal, () =>
      Promise.resolve(content),
    );
    if (opened?.client !== client || opened.uri !== uri)
      throw new Error(
        "A rename participant has a different language server owner. No edits applied.",
      );
    if (client.documentContent(uri) !== content)
      throw sourceChanged("A rename participant changed during synchronization. No edits applied.");
    snapshots.set(uri, { file, content, version: client.documentVersion(uri) });
  }
  const entries = snapshots.size === 1 ? preview : await renameOnSnapshots();
  if (reach !== undefined) {
    const refusal = renameRefusal(
      await clangCoverage(reach, [target.uri, ...entries.keys()], errorsOf, fileOf),
      (file) => (file.startsWith("ssh://") ? file : path.relative(cwd, file)),
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
    const offset = offsets(before.content);
    const changes = edits.map((change) => ({
      from: offset(change.range.start),
      to: offset(change.range.end),
      insert: change.newText,
    }));
    files.push({
      source: before.file,
      expectedContent: before.content,
      changes,
      rebase: (current) =>
        rebaseRename(
          before.content,
          current,
          edits,
          changes,
          oldNames[1] ?? "",
          newName,
          manager.languageId(path.extname(before.file)),
        ),
    });
  }
  checkSnapshots();
  return { files };
}
