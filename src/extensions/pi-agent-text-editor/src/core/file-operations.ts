import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  FileOperation,
  FileOperationInput,
  FileOperationResult,
  FileOperationResolver,
} from "#src/api/file-operations.js";
export { fileOperations } from "#src/api/file-operations.js";
export type { FileOperation, FileOperationResult } from "#src/api/file-operations.js";
const filePath = Type.String({
  minLength: 1,
  description: "Regular file path, relative to cwd or absolute, or an owned resource URI.",
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

const fileOperationResultSchema = Type.Object({
  kind: Type.Literal("file-operation"),
  operation: Type.Union([Type.Literal("copy"), Type.Literal("move"), Type.Literal("delete")]),
  ok: Type.Boolean(),
  effect: Type.Union([
    Type.Literal("applied"),
    Type.Literal("not-applied"),
    Type.Literal("unknown"),
  ]),
  path: Type.Optional(Type.String({ minLength: 1 })),
  target: Type.Optional(Type.String({ minLength: 1 })),
  error: Type.Optional(
    Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String() }),
  ),
});
/** Recognize a host-owned whole-file receipt for shared output rendering. */
export function isFileOperationResult(value: unknown): value is FileOperationResult {
  return Value.Check(fileOperationResultSchema, value);
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
/** Uses maintained filesystem primitives; never decodes file contents or recursively deletes. */
export async function executeFileOperation(
  operation: FileOperation,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
  resolvers: readonly FileOperationResolver[] = [],
  preflight?: (operation: FileOperation, input: FileOperationInput) => Promise<void>,
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
    const args = input as FileOperationInput;
    source = args.path;
    target = args.target;
    signal?.throwIfAborted();
    await preflight?.(operation, args);
    signal?.throwIfAborted();
    for (const resolve of resolvers) {
      started = true;
      const outcome = await resolve(operation, args, { cwd, signal });
      if (outcome !== undefined) {
        if (
          !isFileOperationResult(outcome) ||
          outcome.operation !== operation ||
          (outcome.ok &&
            (outcome.effect !== "applied" ||
              outcome.path === undefined ||
              (operation !== "delete" && outcome.target === undefined)))
        )
          throw Object.assign(new Error("Invalid whole-file provider result"), {
            code: "INVALID_PROVIDER_RESULT",
            effect: "unknown",
          });
        return outcome;
      }
      started = false;
      signal?.throwIfAborted();
    }
    if ([cwd, args.path, args.target].some((value) => value !== undefined && isUriSource(value)))
      throw Object.assign(new Error("No whole-file provider owns this resource"), {
        code: "UNSUPPORTED_SOURCE",
      });
    source = path.resolve(cwd, args.path);
    target = args.target === undefined ? undefined : path.resolve(cwd, args.target);
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
      }
    }
    signal?.throwIfAborted();
    started = true;
    if (operation === "delete") await unlink(source);
    else if (target !== undefined) {
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
      effect: failureEffect(error, started),
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

/** Detect explicit URI sources without mistaking Windows drive paths for schemes. */
export function isUriSource(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) && !/^[a-z]:[/\\]/iu.test(value);
}
function failureEffect(error: unknown, started: boolean): FileOperationResult["effect"] {
  if (
    error !== null &&
    typeof error === "object" &&
    "effect" in error &&
    (error.effect === "applied" || error.effect === "not-applied" || error.effect === "unknown")
  )
    return error.effect;
  return started ? "unknown" : "not-applied";
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
