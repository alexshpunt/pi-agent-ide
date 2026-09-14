import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyTextChanges, type TextChange } from "#src/core/text-change-engine.js";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
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
}

interface TextOperation {
  readonly kind: "replace";
  readonly selection: Selection;
  readonly text: string;
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

export interface EditorTransactionRequest {
  readonly snapshots: readonly EditorSnapshot[];
  readonly operations: readonly (TextOperation | CreateOperation | FileOperation)[];
}

interface SavedPath {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Uint8Array;
}

/** Commit one snapshot-guarded Apply transaction and restore touched paths after a write failure. */
export async function executeEditorTransaction(
  editor: TextEditorCore,
  input: unknown,
  signal: AbortSignal,
  context: ExtensionContext,
): Promise<ScriptMutationOutcome> {
  const request = parseRequest(input);
  if (request.operations.length === 0) throw invalid("apply() requires at least one staged change");

  const snapshots = new Map(request.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (snapshots.size !== request.snapshots.length) throw invalid("Duplicate editor snapshot id");
  const textChanges = new Map<string, TextChange[]>();
  const creates: CreateOperation[] = [];
  const fileOperations: FileOperation[] = [];

  for (const operation of request.operations) {
    if (operation.kind === "replace") {
      const snapshot = snapshots.get(operation.selection.document);
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
      const changes = textChanges.get(snapshot.source) ?? [];
      changes.push({ from, to, insert: operation.text });
      textChanges.set(snapshot.source, changes);
    } else if (operation.kind === "create") creates.push(operation);
    else fileOperations.push(operation);
  }

  validateTextChanges(textChanges);
  const cwd = context.cwd;
  const touched = touchedPaths(cwd, textChanges, creates, fileOperations);
  await preflight(touched, snapshots, textChanges, creates, fileOperations, cwd);
  const saved = await Promise.all([...touched].map(savePath));
  const files: ScriptMutationFile[] = [];

  try {
    if (textChanges.size > 0 || creates.length > 0) {
      const createMap = new Map(
        creates.map((item) => [path.resolve(cwd, item.path), item.content]),
      );
      const sources = new Set([...textChanges.keys(), ...createMap.keys()]);
      const outcome = await editor.editTexts(
        [...sources].map((source) => ({
          source,
          read: true,
          ...(createMap.has(source) && { allowReadFailure: true }),
        })),
        { cwd, signal, intent: "edit" },
        (texts) => {
          for (const snapshot of snapshots.values()) {
            if (textChanges.has(snapshot.source) && texts.get(snapshot.source) !== snapshot.content)
              throw stale(snapshot.source);
          }
          const changes = new Map<string, readonly TextChange[]>();
          for (const source of sources) {
            const before = texts.get(source) ?? "";
            const planned = textChanges.get(source) ?? [
              { from: 0, to: 0, insert: createMap.get(source) ?? "" },
            ];
            changes.set(source, planned);
            const applied = applyTextChanges(before, planned, createMap.has(source));
            files.push({
              source,
              before: createMap.has(source) ? null : before,
              after: applied.content,
              action: createMap.has(source) ? "created" : "edited",
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
          return { changes, result: undefined };
        },
      );
      if (outcome.kind === "failed")
        throw outcome.failure.cause instanceof Error
          ? outcome.failure.cause
          : new Error(outcome.failure.message);
    }

    for (const operation of fileOperations) await performFileOperation(operation, cwd);
    for (const target of fileOperations.flatMap((operation) =>
      operation.target === undefined ? [] : [path.resolve(cwd, operation.target)],
    )) {
      if ((await optionalStat(target)) !== undefined)
        await editor.postProcessFile(target, { cwd, signal });
    }
    const transaction = await editor.recordApplyUndo(saved);
    return {
      operation: "apply",
      transaction,
      ok: true,
      effect: "applied",
      files,
      completed: [...touched],
      errors: [],
    };
  } catch (error) {
    const rollbackErrors = await rollback(saved);
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      code: "TRANSACTION_FAILED",
      details: {
        effect: rollbackErrors.length === 0 ? "rolled-back" : "rollback-incomplete",
        files: [...touched],
        rollbackErrors,
      },
    });
  }
}

function parseRequest(value: unknown): EditorTransactionRequest {
  const request = record(value, "apply() transaction");
  const rawSnapshots = array(request.snapshots, "snapshots");
  const rawOperations = array(request.operations, "operations");
  const snapshots = rawSnapshots.map((value, index) => {
    const item = record(value, `snapshot ${index + 1}`);
    return {
      id: string(item.id, "snapshot id"),
      source: string(item.source, "snapshot source"),
      content: text(item.content, "snapshot content"),
    };
  });
  const operations = rawOperations.map(
    (value, index): TextOperation | CreateOperation | FileOperation => {
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
          },
          text: text(item.text, "replacement text"),
        };
      }
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
    },
  );
  return { snapshots, operations };
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

function validateTextChanges(changes: ReadonlyMap<string, readonly TextChange[]>): void {
  for (const [source, items] of changes) {
    const ordered = [...items].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous !== undefined && current !== undefined && current.from < previous.to)
        throw invalid(`Overlapping selections in ${source}`);
    }
  }
}

function touchedPaths(
  cwd: string,
  changes: ReadonlyMap<string, unknown>,
  creates: readonly CreateOperation[],
  operations: readonly FileOperation[],
): Set<string> {
  const result = new Set([...changes.keys()].map((source) => path.resolve(cwd, source)));
  for (const item of creates) result.add(path.resolve(cwd, item.path));
  for (const item of operations) {
    result.add(path.resolve(cwd, item.path));
    if (item.target !== undefined) result.add(path.resolve(cwd, item.target));
  }
  return result;
}

async function preflight(
  touched: ReadonlySet<string>,
  snapshots: ReadonlyMap<string, EditorSnapshot>,
  changes: ReadonlyMap<string, unknown>,
  creates: readonly CreateOperation[],
  operations: readonly FileOperation[],
  cwd: string,
): Promise<void> {
  for (const file of touched) {
    const stat = await optionalStat(file);
    if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink()))
      throw invalid(`${file} is not a regular file`);
  }
  for (const snapshot of snapshots.values()) {
    if (!changes.has(snapshot.source)) continue;
    let current: string;
    try {
      current = await readFile(snapshot.source, "utf8");
    } catch {
      throw stale(snapshot.source);
    }
    if (current !== snapshot.content) throw stale(snapshot.source);
  }
  const createPaths = creates.map((item) => path.resolve(cwd, item.path));
  if (new Set(createPaths).size !== createPaths.length)
    throw invalid("A transaction cannot create the same path more than once");
  for (const item of creates)
    if ((await optionalStat(path.resolve(cwd, item.path))) !== undefined)
      throw invalid(`Create target exists: ${item.path}`);
  const existence = new Map<string, boolean>();
  for (const file of touched) existence.set(file, (await optionalStat(file)) !== undefined);
  for (const item of creates) existence.set(path.resolve(cwd, item.path), true);
  for (const item of operations) {
    const source = path.resolve(cwd, item.path);
    if (existence.get(source) !== true) throw invalid(`Source does not exist: ${item.path}`);
    if (item.kind === "delete") {
      existence.set(source, false);
      continue;
    }
    const target = path.resolve(cwd, item.target ?? "");
    if (source === target) throw invalid("Source and target are the same file");
    if (existence.get(target) === true && item.overwrite !== true)
      throw invalid(`Target exists: ${item.target}`);
    existence.set(target, true);
    if (item.kind === "move") existence.set(source, false);
  }
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

async function rollback(saved: readonly SavedPath[]): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const item of [...saved].reverse()) {
    try {
      if (item.existed) {
        await mkdir(path.dirname(item.path), { recursive: true });
        await writeFile(item.path, item.bytes ?? new Uint8Array());
      } else await rm(item.path, { force: true });
    } catch (error) {
      if (!item.existed && (isCode(error, "ENOENT") || isCode(error, "ENOTDIR"))) continue;
      errors.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
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
  return Object.assign(new Error(`Snapshot changed before apply(): ${source}`), {
    code: "STALE_SNAPSHOT",
  });
}
