import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Whole-file operations, distinct from text-selection copy/move/remove. */
export const fileOperations = ["delete_file", "move_file", "copy_file"] as const;
export type FileOperation = (typeof fileOperations)[number];
const filePath = Type.String({
  minLength: 1,
  description: "Local regular file path, relative to cwd or absolute.",
});
export const deleteFileParameters = Type.Object(
  { path: filePath },
  { additionalProperties: false },
);
export const transferFileParameters = Type.Object(
  {
    path: filePath,
    target: filePath,
    overwrite: Type.Optional(
      Type.Boolean({
        description: "Allow replacing an existing regular target file. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Plain receipt; unknown means the filesystem call failed after execution began. */
export interface FileOperationResult {
  readonly kind: "file-operation";
  readonly operation: FileOperation;
  readonly ok: boolean;
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly path?: string;
  readonly target?: string;
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

/** Compact operation summary shared by standalone and Apply output. */
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
/** Uses maintained filesystem primitives; never decodes file contents or recursively deletes. */
export async function executeFileOperation(
  operation: FileOperation,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<FileOperationResult> {
  let started = false;
  let source: string | undefined;
  let target: string | undefined;
  try {
    const schema = operation === "delete_file" ? deleteFileParameters : transferFileParameters;
    if (!Value.Check(schema, input))
      throw Object.assign(new Error("Invalid file operation arguments"), {
        code: "INVALID_ARGUMENTS",
      });
    const args = input as { path: string; target?: string; overwrite?: boolean };
    source = path.resolve(cwd, args.path);
    target = args.target === undefined ? undefined : path.resolve(cwd, args.target);
    signal?.throwIfAborted();
    const sourceStat = await regularFile(source);
    if (target !== undefined) {
      const targetStat = await optionalStat(target);
      if (targetStat !== undefined) {
        if (!targetStat.isFile() || targetStat.isSymbolicLink())
          throw Object.assign(new Error("Target must be a regular file"), {
            code: "INVALID_FILE_TYPE",
          });
        if (
          source === target ||
          (sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev)
        )
          throw Object.assign(new Error("Source and target are the same file"), {
            code: "SAME_FILE",
          });
        if (args.overwrite !== true)
          throw Object.assign(new Error("Target exists; use overwrite: true to replace it"), {
            code: "EEXIST",
          });
      }
    }
    signal?.throwIfAborted();
    started = true;
    if (operation === "delete_file") await unlink(source);
    else if (target !== undefined) {
      if (operation === "copy_file")
        await fs.copy(source, target, { overwrite: args.overwrite === true, errorOnExist: true });
      else await fs.move(source, target, { overwrite: args.overwrite === true });
    }
    return {
      kind: "file-operation",
      operation,
      ok: true,
      effect: "applied",
      path: source,
      ...(target === undefined ? {} : { target }),
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

async function regularFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Object.assign(new Error("Source must be a regular file"), { code: "INVALID_FILE_TYPE" });
  return stat;
}
async function optionalStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
