import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import { requiredValue } from "pi-agent-invariant";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyTextChanges, type TextChange } from "#src/core/text-change-engine.js";
import type { TextEditorCore } from "#src/core/text-editor-core.js";

import { forgetDeferredPostEdit } from "#src/core/post-edit-scope.js";
import type {
  ScriptMutationFile,
  ScriptMutationOutcome,
} from "#src/core/apply/mutation-outcome.js";

export interface EditorSnapshot {
  readonly id: string;
  readonly source: string;
  readonly content: string;
}
interface Selection {
  readonly document: string;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly linewise?: boolean;
}
interface TextOperation {
  readonly kind: "replace";
  readonly selection: Selection;
  readonly text: string;
}
type TextTransferOperation = {
  readonly sources: readonly Selection[];
  readonly destinations: readonly Selection[];
  readonly text: string;
} & ({ readonly kind: "text-copy" } | { readonly kind: "text-move" });
interface WarningOperation {
  readonly kind: "warning";
  readonly document: string;
  readonly query?: string;
  readonly warning?: unknown;
}
interface CreateOperation {
  readonly kind: "create";
  readonly path: string;
  readonly content: string;
}
interface FileOperation {
  readonly kind: "delete" | "copy" | "move";
  readonly path: string;
  readonly target?: string;
  readonly overwrite?: boolean;
}
type Operation =
  | TextOperation
  | TextTransferOperation
  | WarningOperation
  | CreateOperation
  | FileOperation;
export interface EditorTransactionRequest {
  readonly snapshots: readonly EditorSnapshot[];
  readonly operations: readonly Operation[];
}
/** Captured path state used to restore one failed operation. */
export interface SavedPath {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Uint8Array;
}
export interface ApplyOperationOutcome {
  readonly index: number;
  readonly kind: Operation["kind"];
  readonly status: "applied" | "warning" | "failed" | "unknown" | "blocked";
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly resources: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly warning?: {
    readonly code: string;
    readonly message: string;
    readonly presentation?: unknown;
  };
}

export type TransactionEditor = Pick<
  TextEditorCore,
  "editTexts" | "postProcessFile" | "recordApplyUndo"
>;

/** Optional transaction execution dependencies for deterministic failure handling. */
export interface TransactionExecutionOptions {
  /** Restore one captured path after an operation fails. */
  readonly restorePath?: (state: SavedPath) => Promise<void>;
}

/** Commit staged operations independently and return every outcome in staging order. */
export async function executeEditorTransaction(
  editor: TransactionEditor,
  input: unknown,
  signal: AbortSignal,
  context: Pick<ExtensionContext, "cwd">,
  options: TransactionExecutionOptions = {},
): Promise<ScriptMutationOutcome> {
  const request = parseRequest(input);
  if (request.operations.length === 0) throw invalid("flush() requires at least one staged change");
  const snapshots = new Map(request.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (snapshots.size !== request.snapshots.length) throw invalid("Duplicate editor snapshot id");

  const accepted = new Map<string, TextChange[]>();
  const unknown = new Set<string>();
  const journal = new Map<string, SavedPath>();
  const files: ScriptMutationFile[] = [];
  const operations: ApplyOperationOutcome[] = [];
  const cwd = context.cwd;
  const batchedReplacements = new Set<number>();

  for (const [index, operation] of request.operations.entries()) {
    const resources = operationResources(operation, snapshots, cwd);
    if (batchedReplacements.has(index)) continue;
    if (operation.kind === "replace") {
      const replacements: Array<{ index: number; operation: TextOperation }> = [];
      for (
        let candidateIndex = index;
        candidateIndex < request.operations.length;
        candidateIndex += 1
      ) {
        const candidate = request.operations[candidateIndex];
        if (
          candidate?.kind !== "replace" ||
          candidate.selection.document !== operation.selection.document
        )
          break;
        replacements.push({ index: candidateIndex, operation: candidate });
      }
      if (replacements.length > 1) {
        for (const replacement of replacements) batchedReplacements.add(replacement.index);
        const outcome = await executeReplacementBatch(
          replacements,
          snapshots,
          accepted,
          editor,
          cwd,
          signal,
          options,
        );
        for (const state of outcome.saved)
          if (!journal.has(state.path)) journal.set(state.path, state);
        files.push(...outcome.files);
        operations.push(...outcome.operations);
        continue;
      }
    }
    if (operation.kind === "warning") {
      operations.push({
        index,
        kind: "warning",
        status: "warning",
        effect: "not-applied",
        resources,
        warning: warningDetails(operation),
      });
      continue;
    }
    if (resources.some((resource) => unknown.has(resource))) {
      operations.push({
        index,
        kind: operation.kind,
        status: "blocked",
        effect: "unknown",
        resources,
        error: {
          code: "DEPENDENCY_UNKNOWN",
          message: "A prior operation left a required resource in an unknown state.",
        },
      });
      continue;
    }
    if (operation.kind === "replace") {
      const snapshot = snapshots.get(operation.selection.document);
      const prior = snapshot === undefined ? [] : (accepted.get(snapshot.source) ?? []);
      if (prior.some((change) => overlaps(change, operation.selection))) {
        operations.push(
          failed(
            index,
            operation,
            resources,
            invalid(`Overlapping selection in ${snapshot?.source ?? "unknown snapshot"}`),
          ),
        );
        continue;
      }
    }

    let saved: readonly SavedPath[] = [];
    try {
      await validateOperation(operation, snapshots, accepted, cwd);
      saved = await Promise.all(resources.map(savePath));
      const produced = await executeOperation(operation, snapshots, accepted, editor, cwd, signal);
      for (const state of saved) if (!journal.has(state.path)) journal.set(state.path, state);
      files.push(...produced);
      operations.push({
        index,
        kind: operation.kind,
        status: "applied",
        effect: "applied",
        resources,
      });
    } catch (error) {
      const rollbackErrors = await rollback(saved, options.restorePath);
      if (rollbackErrors.length > 0) {
        for (const resource of resources) unknown.add(resource);
        operations.push({
          index,
          kind: operation.kind,
          status: "unknown",
          effect: "unknown",
          resources,
          error: codedError(error, rollbackErrors),
        });
      } else operations.push(failed(index, operation, resources, error));
    }
  }

  const successful = operations.some(({ effect }) => effect === "applied");
  const transaction = successful ? await editor.recordApplyUndo([...journal.values()]) : undefined;
  return {
    operation: "apply",
    ok: operations.length > 0 && operations.every(({ status }) => status === "applied"),
    effect: unknown.size > 0 ? "unknown" : successful ? "applied" : "not-applied",
    ...(transaction === undefined ? {} : { transaction }),
    files,
    completed: [
      ...new Set(
        operations
          .filter(({ effect }) => effect === "applied")
          .flatMap(({ resources }) => resources),
      ),
    ],
    errors: operations.flatMap((item) =>
      item.status === "warning" || item.error === undefined
        ? []
        : [{ source: item.resources.join(", "), ...item.error }],
    ),
    operations,
  };
}

async function executeReplacementBatch(
  replacements: readonly { readonly index: number; readonly operation: TextOperation }[],
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  accepted: Map<string, TextChange[]>,
  editor: TransactionEditor,
  cwd: string,
  signal: AbortSignal,
  options: TransactionExecutionOptions,
): Promise<{
  readonly saved: readonly SavedPath[];
  readonly files: readonly ScriptMutationFile[];
  readonly operations: readonly ApplyOperationOutcome[];
}> {
  const first = requiredValue(replacements[0]);
  const snapshot = snapshots.get(first.operation.selection.document);
  const resources = operationResources(first.operation, snapshots, cwd);
  if (snapshot === undefined)
    return {
      saved: [],
      files: [],
      operations: replacements.map(({ index, operation }) =>
        failed(
          index,
          operation,
          resources,
          invalid("Selection belongs to an unknown editor snapshot"),
        ),
      ),
    };

  const prior = accepted.get(snapshot.source) ?? [];
  const additions: TextChange[] = [];
  const operationResults = new Map<number, ApplyOperationOutcome>();
  for (const { index, operation } of replacements) {
    try {
      validateSelection(operation, snapshot);
      if (
        prior.some((change) => overlaps(change, operation.selection)) ||
        additions.some((change) => overlaps(change, operation.selection))
      )
        throw invalid(`Overlapping selection in ${snapshot.source}`);
      additions.push({
        from: operation.selection.from,
        to: operation.selection.to,
        insert: preserveLineEnding(operation.selection, operation.text),
      });
    } catch (error) {
      operationResults.set(index, failed(index, operation, resources, error));
    }
  }
  if (additions.length === 0)
    return {
      saved: [],
      files: [],
      operations: replacements.map(({ index }) => requiredValue(operationResults.get(index))),
    };

  const before = applyTextChanges(snapshot.content, prior).content;
  let current: string;
  try {
    current = await readFile(snapshot.source, "utf8");
    if (current !== before) throw stale(snapshot.source);
  } catch (error) {
    for (const { index, operation } of replacements)
      if (!operationResults.has(index))
        operationResults.set(index, failed(index, operation, resources, error));
    return {
      saved: [],
      files: [],
      operations: replacements.map(({ index }) => requiredValue(operationResults.get(index))),
    };
  }

  const saved = [await savePath(snapshot.source)];
  const combined = [...prior, ...additions];
  const applied = applyTextChanges(snapshot.content, combined);
  try {
    await editOne(editor, snapshot.source, before, applied.content, cwd, signal, false);
    accepted.set(snapshot.source, combined);
    for (const { index, operation } of replacements)
      if (!operationResults.has(index))
        operationResults.set(index, {
          index,
          kind: operation.kind,
          status: "applied",
          effect: "applied",
          resources,
        });
    return {
      saved,
      files: [
        {
          source: snapshot.source,
          before,
          after: applied.content,
          action: "edited",
          changes: applied.changes.map((change, editIndex) => ({
            editIndex,
            fromA: change.fromBefore,
            toA: change.toBefore,
            fromB: change.fromAfter,
            toB: change.toAfter,
            removedText: change.removedText,
            insertedText: change.insertedText,
          })),
          formatting: { status: "not-reported" },
        },
      ],
      operations: replacements.map(({ index }) => requiredValue(operationResults.get(index))),
    };
  } catch (error) {
    const rollbackErrors = await rollback(saved, options.restorePath);
    for (const { index, operation } of replacements)
      if (!operationResults.has(index))
        operationResults.set(
          index,
          rollbackErrors.length === 0
            ? failed(index, operation, resources, error)
            : {
                index,
                kind: operation.kind,
                status: "unknown",
                effect: "unknown",
                resources,
                error: codedError(error, rollbackErrors),
              },
        );
    return {
      saved: rollbackErrors.length === 0 ? [] : saved,
      files: [],
      operations: replacements.map(({ index }) => requiredValue(operationResults.get(index))),
    };
  }
}

async function validateOperation(
  operation: Operation,
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  accepted: ReadonlyMap<string, readonly TextChange[]>,
  cwd: string,
): Promise<void> {
  if (operation.kind === "warning") return;
  if (operation.kind === "text-copy" || operation.kind === "text-move") {
    const selected =
      operation.kind === "text-move"
        ? [...operation.destinations, ...operation.sources]
        : [...operation.destinations];
    for (const selection of [...operation.sources, ...operation.destinations])
      validateSelection(
        { kind: "replace", selection, text: "" },
        snapshots.get(selection.document),
      );
    for (const [index, selection] of selected.entries()) {
      const snapshot = requiredValue(snapshots.get(selection.document));
      const prior = accepted.get(snapshot.source) ?? [];
      if (
        prior.some((change) => overlaps(change, selection)) ||
        selected
          .slice(0, index)
          .some((other) => other.document === selection.document && rangesOverlap(other, selection))
      )
        throw invalid(`Overlapping selection in ${snapshot.source}`);
    }
    for (const document of new Set(
      [...operation.sources, ...operation.destinations].map(({ document }) => document),
    )) {
      const snapshot = requiredValue(snapshots.get(document));
      const expected = applyTextChanges(
        snapshot.content,
        accepted.get(snapshot.source) ?? [],
      ).content;
      let current;
      try {
        current = await readFile(snapshot.source, "utf8");
      } catch {
        throw stale(snapshot.source);
      }
      if (current !== expected) throw stale(snapshot.source);
    }
    return;
  }
  if (operation.kind === "replace") {
    const snapshot = snapshots.get(operation.selection.document);
    validateSelection(operation, snapshot);
    const expected = applyTextChanges(
      snapshot.content,
      accepted.get(snapshot.source) ?? [],
    ).content;
    let current: string;
    try {
      current = await readFile(snapshot.source, "utf8");
    } catch {
      throw stale(snapshot.source);
    }
    if (current !== expected) throw stale(snapshot.source);
    return;
  }
  const source = path.resolve(cwd, operation.path);
  const sourceStat = await optionalStat(source);
  if (operation.kind === "create") {
    if (sourceStat !== undefined) throw invalid(`Create target exists: ${operation.path}`);
    return;
  }
  if (sourceStat === undefined) throw invalid(`Source does not exist: ${operation.path}`);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw invalid(`${source} is not a regular file`);
  if (operation.kind === "delete") return;
  const target = path.resolve(cwd, operation.target ?? "");
  if (source === target) throw invalid("Source and target are the same file");
  const targetStat = await optionalStat(target);
  if (targetStat !== undefined && (!targetStat.isFile() || targetStat.isSymbolicLink()))
    throw invalid(`${target} is not a regular file`);
  if (targetStat !== undefined && operation.overwrite !== true)
    throw invalid(`Target exists: ${operation.target}`);
}

async function executeOperation(
  operation: Operation,
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  accepted: Map<string, TextChange[]>,
  editor: TransactionEditor,
  cwd: string,
  signal: AbortSignal,
): Promise<ScriptMutationFile[]> {
  if (operation.kind === "warning") return [];
  if (operation.kind === "text-copy" || operation.kind === "text-move")
    return executeTextTransfer(operation, snapshots, accepted, editor, cwd, signal);
  if (operation.kind === "replace") {
    const snapshot = snapshots.get(operation.selection.document);
    if (snapshot === undefined) throw invalid("Selection belongs to an unknown editor snapshot");
    const prior = accepted.get(snapshot.source) ?? [];
    const next = [
      ...prior,
      {
        from: operation.selection.from,
        to: operation.selection.to,
        insert: preserveLineEnding(operation.selection, operation.text),
      },
    ];
    const before = applyTextChanges(snapshot.content, prior).content;
    const applied = applyTextChanges(snapshot.content, next);
    await editOne(editor, snapshot.source, before, applied.content, cwd, signal, false);
    accepted.set(snapshot.source, next);
    return [
      {
        source: snapshot.source,
        before,
        after: applied.content,
        action: "edited",
        changes: applied.changes.map((change, editIndex) => ({
          editIndex,
          fromA: change.fromBefore,
          toA: change.toBefore,
          fromB: change.fromAfter,
          toB: change.toAfter,
          removedText: change.removedText,
          insertedText: change.insertedText,
        })),
        formatting: { status: "not-reported" },
      },
    ];
  }
  if (operation.kind === "create") {
    const source = path.resolve(cwd, operation.path);
    await editOne(editor, source, "", operation.content, cwd, signal, true);
    return [
      {
        source,
        before: null,
        after: operation.content,
        action: "created",
        changes: [],
        formatting: { status: "not-reported" },
      },
    ];
  }
  await performFileOperation(operation, cwd);
  if (operation.kind === "delete" || operation.kind === "move") {
    forgetDeferredPostEdit(path.resolve(cwd, operation.path));
  }
  if (operation.target !== undefined) {
    const target = path.resolve(cwd, operation.target);
    if ((await optionalStat(target)) !== undefined)
      await editor.postProcessFile(target, { cwd, signal });
  }
  return [];
}

function preserveLineEnding(selection: Selection, insert: string): string {
  if (insert.length === 0 || selection.linewise !== true || /(?:\r\n|\r|\n)$/u.test(insert))
    return insert;
  return insert + (/(?:\r\n|\r|\n)$/u.exec(selection.text)?.[0] ?? "");
}
function rangesOverlap(left: Selection, right: Selection): boolean {
  return left.from < right.to && right.from < left.to;
}
function transferInsert(snapshot: EditorSnapshot, destination: Selection, text: string): string {
  if (destination.from !== destination.to || destination.linewise !== true || text.length === 0)
    return text;
  const separator = snapshot.content.includes("\r\n") ? "\r\n" : "\n";
  const before = snapshot.content.slice(0, destination.from);
  const after = snapshot.content.slice(destination.to);
  const prefix = before.length > 0 && !/(?:\r\n|\r|\n)$/u.test(before) ? separator : "";
  const suffix = after.length > 0 && !/(?:\r\n|\r|\n)$/u.test(text) ? separator : "";
  return prefix + text + suffix;
}
async function executeTextTransfer(
  operation: TextTransferOperation,
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  accepted: Map<string, TextChange[]>,
  editor: TransactionEditor,
  cwd: string,
  signal: AbortSignal,
): Promise<ScriptMutationFile[]> {
  const additions = new Map<string, TextChange[]>();
  for (const destination of operation.destinations) {
    const snapshot = requiredValue(snapshots.get(destination.document));
    const changes = additions.get(snapshot.source) ?? [];
    changes.push({
      from: destination.from,
      to: destination.to,
      insert: transferInsert(snapshot, destination, operation.text),
    });
    additions.set(snapshot.source, changes);
  }
  if (operation.kind === "text-move")
    for (const source of operation.sources) {
      const snapshot = requiredValue(snapshots.get(source.document));
      const changes = additions.get(snapshot.source) ?? [];
      changes.push({ from: source.from, to: source.to, insert: "" });
      additions.set(snapshot.source, changes);
    }
  const sourcePaths = [...additions.keys()];
  const before = new Map(
    sourcePaths.map((source) => {
      const snapshot = requiredValue(
        [...snapshots.values()].find((item) => item.source === source),
      );
      return [
        source,
        applyTextChanges(snapshot.content, accepted.get(source) ?? []).content,
      ] as const;
    }),
  );
  const after = new Map<string, string>();
  const outcome = await editor.editTexts(
    sourcePaths.map((source) => ({ source, read: true })),
    { cwd, signal, intent: "edit" },
    (texts) => {
      const changes = new Map<string, TextChange[]>();
      for (const source of sourcePaths) {
        if (texts.get(source) !== before.get(source)) throw stale(source);
        const combined = [...(accepted.get(source) ?? []), ...(additions.get(source) ?? [])];
        const snapshot = requiredValue(
          [...snapshots.values()].find((item) => item.source === source),
        );
        after.set(source, applyTextChanges(snapshot.content, combined).content);
        changes.set(source, additions.get(source) ?? []);
      }
      return { changes, result: undefined };
    },
  );
  if (outcome.kind === "failed")
    throw outcome.failure.cause instanceof Error
      ? outcome.failure.cause
      : new Error(outcome.failure.message);
  const files: ScriptMutationFile[] = [];
  for (const source of sourcePaths) {
    const snapshot = requiredValue([...snapshots.values()].find((item) => item.source === source));
    const combined = [...(accepted.get(source) ?? []), ...(additions.get(source) ?? [])];
    accepted.set(source, combined);
    const applied = applyTextChanges(snapshot.content, combined);
    files.push({
      source,
      before: requiredValue(before.get(source)),
      after: requiredValue(after.get(source)),
      action: "edited",
      changes: applied.changes.map((change, editIndex) => ({
        editIndex,
        fromA: change.fromBefore,
        toA: change.toBefore,
        fromB: change.fromAfter,
        toB: change.toAfter,
        removedText: change.removedText,
        insertedText: change.insertedText,
      })),
      formatting: { status: "not-reported" },
    });
  }
  return files;
}
async function editOne(
  editor: TransactionEditor,
  source: string,
  before: string,
  after: string,
  cwd: string,
  signal: AbortSignal,
  create: boolean,
): Promise<void> {
  const outcome = await editor.editTexts(
    [{ source, read: true, ...(create && { allowReadFailure: true }) }],
    { cwd, signal, intent: "edit" },
    (texts) => {
      if ((texts.get(source) ?? "") !== before) throw stale(source);
      return {
        changes: new Map([[source, [{ from: 0, to: before.length, insert: after }]]]),
        result: undefined,
      };
    },
  );
  if (outcome.kind === "failed")
    throw outcome.failure.cause instanceof Error
      ? outcome.failure.cause
      : new Error(outcome.failure.message);
}

function validateSelection(
  operation: TextOperation,
  snapshot: EditorSnapshot | undefined,
): asserts snapshot is EditorSnapshot {
  if (snapshot === undefined) throw invalid("Selection belongs to an unknown editor snapshot");
  const { from, to, text } = operation.selection;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > snapshot.content.length
  )
    throw invalid(`Selection ${from}-${to} is outside ${snapshot.source}`);
  if (snapshot.content.slice(from, to) !== text)
    throw invalid(`Selection text does not match ${snapshot.source}`);
}
function overlaps(change: TextChange, selection: Selection): boolean {
  return selection.from < change.to && change.from < selection.to;
}
function operationResources(
  operation: Operation,
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  cwd: string,
): string[] {
  if (operation.kind === "text-copy" || operation.kind === "text-move")
    return [
      ...new Set(
        [...operation.sources, ...operation.destinations].flatMap((selection) => {
          const snapshot = snapshots.get(selection.document);
          return snapshot === undefined ? [] : [path.resolve(cwd, snapshot.source)];
        }),
      ),
    ];
  if (operation.kind === "warning") {
    const snapshot = snapshots.get(operation.document);
    return snapshot === undefined ? [] : [path.resolve(cwd, snapshot.source)];
  }
  if (operation.kind === "replace") {
    const snapshot = snapshots.get(operation.selection.document);
    return snapshot === undefined ? [] : [path.resolve(cwd, snapshot.source)];
  }
  return [
    path.resolve(cwd, operation.path),
    ...("target" in operation && operation.target !== undefined
      ? [path.resolve(cwd, operation.target)]
      : []),
  ];
}
function warningDetails(operation: WarningOperation): {
  code: string;
  message: string;
  presentation?: unknown;
} {
  if (operation.warning !== null && typeof operation.warning === "object") {
    const value = operation.warning as Record<string, unknown>;
    return {
      code: typeof value.code === "string" ? value.code : "EMPTY_SELECTION",
      message:
        typeof value.message === "string"
          ? value.message
          : "SelectionSet is empty; no edit was applied.",
      ...(value.presentation !== undefined && { presentation: value.presentation }),
    };
  }
  return {
    code: "EMPTY_SELECTION",
    message:
      operation.query === undefined
        ? "SelectionSet is empty; no edit was applied."
        : `SelectionSet for "${operation.query}" is empty; no edit was applied.`,
  };
}
function failed(
  index: number,
  operation: Operation,
  resources: readonly string[],
  error: unknown,
): ApplyOperationOutcome {
  return {
    index,
    kind: operation.kind,
    status: "failed",
    effect: "not-applied",
    resources,
    error: codedError(error),
  };
}
function codedError(
  error: unknown,
  rollbackErrors: readonly string[] = [],
): { code: string; message: string } {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "OPERATION_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: rollbackErrors.length ? "ROLLBACK_INCOMPLETE" : code,
    message: rollbackErrors.length
      ? `${message}; rollback failed: ${rollbackErrors.join("; ")}`
      : message,
  };
}

function parseRequest(value: unknown): EditorTransactionRequest {
  const request = record(value, "flush() transaction");
  const snapshots = array(request.snapshots, "snapshots").map((value, index) => {
    const item = record(value, `snapshot ${index + 1}`);
    return {
      id: string(item.id, "snapshot id"),
      source: string(item.source, "snapshot source"),
      content: text(item.content, "snapshot content"),
    };
  });
  const operations = array(request.operations, "operations").map((value, index): Operation => {
    const item = record(value, `operation ${index + 1}`);
    const kind = string(item.kind, "operation kind");
    if (kind === "replace") {
      const selected = record(item.selection, "selection");
      return {
        kind,
        selection: {
          document: string(selected.document, "selection document"),
          from: integer(selected.from, "selection from"),
          to: integer(selected.to, "selection to"),
          text: text(selected.text, "selection text"),
          ...(selected.linewise === true && { linewise: true }),
        },
        text: text(item.text, "replacement text"),
      };
    }
    if (kind === "text-copy" || kind === "text-move")
      return {
        kind,
        sources: selections(item.sources, "transfer sources"),
        destinations: selections(item.destinations, "transfer destinations"),
        text: text(item.text, "transfer text"),
      };
    if (kind === "warning")
      return {
        kind,
        document: string(item.document, "warning document"),
        ...(typeof item.query === "string" && { query: item.query }),
        ...(item.warning !== undefined && { warning: item.warning }),
      };
    if (kind === "create")
      return {
        kind,
        path: string(item.path, "create path"),
        content: text(item.content, "create content"),
      };
    if (kind === "delete") return { kind, path: string(item.path, "delete path") };
    if (kind === "copy" || kind === "move")
      return {
        kind,
        path: string(item.path, `${kind} path`),
        target: string(item.target, `${kind} target`),
        ...(item.overwrite === true && { overwrite: true }),
      };
    throw invalid(`Unknown transaction operation: ${kind}`);
  });
  return { snapshots, operations };
}
function selections(value: unknown, label: string): Selection[] {
  return array(value, label).map((entry, index) => {
    const item = record(entry, `${label} ${index + 1}`);
    return {
      document: string(item.document, "selection document"),
      from: integer(item.from, "selection from"),
      to: integer(item.to, "selection to"),
      text: text(item.text, "selection text"),
      ...(item.linewise === true && { linewise: true }),
    };
  });
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(`${label} must be a non-empty string`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw invalid(`${label} must be an integer`);
  return value as number;
}
async function performFileOperation(operation: FileOperation, cwd: string): Promise<void> {
  const source = path.resolve(cwd, operation.path);
  if (operation.kind === "delete") {
    await rm(source);
    return;
  }
  const target = path.resolve(cwd, operation.target ?? "");
  await mkdir(path.dirname(target), { recursive: true });
  if (operation.kind === "copy")
    await fs.copy(source, target, { overwrite: operation.overwrite === true, errorOnExist: true });
  else await fs.move(source, target, { overwrite: operation.overwrite === true });
}
async function savePath(file: string): Promise<SavedPath> {
  try {
    return { path: file, existed: true, bytes: await readFile(file) };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { path: file, existed: false };
    throw error;
  }
}
async function rollback(
  saved: readonly SavedPath[],
  restorePath: (state: SavedPath) => Promise<void> = restoreSavedPath,
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const item of [...saved].reverse())
    try {
      await restorePath(item);
    } catch (error) {
      if (!item.existed && (isCode(error, "ENOENT") || isCode(error, "ENOTDIR"))) continue;
      errors.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  return errors;
}
async function restoreSavedPath(item: SavedPath): Promise<void> {
  if (item.existed) {
    await mkdir(path.dirname(item.path), { recursive: true });
    await writeFile(item.path, item.bytes ?? new Uint8Array());
  } else await rm(item.path, { force: true });
}
async function optionalStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_TRANSACTION" });
}
function stale(source: string): Error {
  return Object.assign(new Error(`Snapshot changed before flush(): ${source}`), {
    code: "STALE_SNAPSHOT",
  });
}
