import { lstat, rm, unlink } from "node:fs/promises";
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
    const sourceStat = deleteEvent === undefined ? await regularFile(source) : undefined;
    if (target !== undefined) {
      const targetStat = await optionalStat(target);
      if (targetStat !== undefined) {
        if (!targetStat.isFile() || targetStat.isSymbolicLink())
          throw Object.assign(new Error("Target must be a regular file"), {
            code: "INVALID_FILE_TYPE",
          });
        if (
          source === target ||
          (sourceStat !== undefined &&
            sourceStat.ino === targetStat.ino &&
            sourceStat.dev === targetStat.dev)
        )
          throw Object.assign(new Error("Source and target are the same file"), {
            code: "SAME_FILE",
          });
      }
    }
    signal?.throwIfAborted();
    started = true;
    if (deleteEvent !== undefined) {
      if (deleteEvent.recursive) {
        if (deletion.removeDirectory !== undefined)
          await deletion.removeDirectory(deleteEvent.resolvedPath);
        else await rm(deleteEvent.resolvedPath, { recursive: true, force: false });
      } else await unlink(deleteEvent.resolvedPath);
    } else if (target !== undefined) {
      if (operation === "copy") await fs.copy(source, target, { overwrite: true });
      else await fs.move(source, target, { overwrite: true });
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
