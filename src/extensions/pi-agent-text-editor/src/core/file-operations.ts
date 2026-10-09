import { rm, unlink } from "node:fs/promises";
import { prepareFileTransfer, type TransferKind } from "./file-transfers.js";
import { prepareDeletion, type DeletePolicyContext } from "./delete-policy.js";
import path from "node:path";
import fs from "fs-extra";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Whole-file operations, distinct from text-selection copy/move/remove. */
export const fileOperations = ["delete", "move", "copy"] as const;
export type FileOperation = (typeof fileOperations)[number];
const filePath = Type.String({
  minLength: 1,
  description: "Local file, directory, or symlink path, relative to cwd or absolute.",
});
export const deleteFileParameters = Type.Object(
  { path: filePath },
  { additionalProperties: false },
);
export const transferFileParameters = Type.Object(
  {
    path: filePath,
    target: filePath,
  },
  { additionalProperties: false },
);

/** Host dependencies for deletion; no tool argument can replace the filesystem primitive. */
export interface FileOperationContext extends DeletePolicyContext {
  readonly removeDirectory?: (source: string) => Promise<void>;
}
/** Plain receipt; unknown means the filesystem call failed after execution began. */
export interface FileOperationResult {
  readonly kind: "file-operation";
  readonly operation: FileOperation;
  readonly ok: boolean;
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly path?: string;
  readonly target?: string;
  readonly sourceKind?: TransferKind;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Recognize a host-owned whole-file receipt for shared output rendering. */
export function isFileOperationResult(value: unknown): value is FileOperationResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "file-operation"
  );
}

/** Compact whole-file operation summary. */
export function formatFileOperation(value: FileOperationResult): string {
  return [
    `${value.operation}: ${value.effect}`,
    value.path,
    value.target === undefined ? undefined : `Target: ${value.target}`,
    value.error === undefined ? undefined : `${value.error.code}: ${value.error.message}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
/** Uses filesystem primitives without decoding contents; Delete applies hooks and safety policy first. */
export async function executeFileOperation(
  operation: FileOperation,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
  deletion: FileOperationContext = {},
): Promise<FileOperationResult> {
  let started = false;
  let source: string | undefined;
  let target: string | undefined;
  let sourceKind: TransferKind | undefined;
  try {
    const schema = operation === "delete" ? deleteFileParameters : transferFileParameters;
    if (!Value.Check(schema, input))
      throw Object.assign(new Error("Invalid file operation arguments"), {
        code: "INVALID_ARGUMENTS",
      });
    const args = input as { path: string; target?: string };
    source = path.resolve(cwd, args.path);
    target = args.target === undefined ? undefined : path.resolve(cwd, args.target);
    signal?.throwIfAborted();
    const deleteEvent =
      operation === "delete" ? await prepareDeletion(source, cwd, deletion, signal) : undefined;
    const transfer =
      operation !== "delete" && target !== undefined
        ? await prepareFileTransfer(operation, source, target, cwd, deletion, signal)
        : undefined;
    sourceKind = transfer?.sourceKind;
    signal?.throwIfAborted();
    started = true;
    if (deleteEvent !== undefined) {
      if (deleteEvent.recursive) {
        if (deletion.removeDirectory !== undefined)
          await deletion.removeDirectory(deleteEvent.resolvedPath);
        else await rm(deleteEvent.resolvedPath, { recursive: true, force: false });
      } else await unlink(deleteEvent.resolvedPath);
    } else if (transfer !== undefined) {
      if (operation === "copy")
        await fs.copy(transfer.source, transfer.target, { overwrite: true, dereference: false });
      else await fs.move(transfer.source, transfer.target, { overwrite: true });
    }
    return {
      kind: "file-operation",
      operation,
      ok: true,
      effect: "applied",
      path: source,
      ...(target === undefined ? {} : { target }),
      ...(sourceKind === undefined ? {} : { sourceKind }),
    };
  } catch (error) {
    return {
      kind: "file-operation",
      operation,
      ok: false,
      effect: started ? "unknown" : "not-applied",
      ...(source === undefined ? {} : { path: source }),
      ...(target === undefined ? {} : { target }),
      error: {
        code:
          error !== null && typeof error === "object" && "code" in error
            ? String(error.code)
            : "FILE_OPERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
