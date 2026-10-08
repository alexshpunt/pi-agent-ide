import type { Stats } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertUnprotectedTransferPath,
  prepareDeletionGuard,
  type DeletePolicyContext,
  type DeletionGuard,
} from "./delete-policy.js";

/** Object kinds supported by byte-preserving whole-object transfers. */
export type TransferKind = "file" | "directory" | "symlink";

/** Preflight transfers and retain canonical paths; never dereference the final link. */
export async function prepareFileTransfer(
  operation: "copy" | "move",
  source: string,
  target: string,
  cwd: string,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<{ source: string; target: string; sourceKind: TransferKind }> {
  const before = await inspectTransfer(operation, source, target, cwd, signal);
  const guards: DeletionGuard[] = [];
  if (operation === "move" && before.sourceKind !== "file") {
    guards.push(await prepareDeletionGuard(source, cwd, context, signal));
    if (before.targetExists) guards.push(await prepareDeletionGuard(target, cwd, context, signal));
  }
  // A later dialog or hook can change an earlier approved object. Recheck all approvals together.
  for (const guard of guards) await guard.verify();
  const after = await inspectTransfer(operation, source, target, cwd, signal);
  if (before.snapshot !== after.snapshot)
    fail(
      "TRANSFER_TARGET_CHANGED",
      "Transfer paths or contents changed during preflight. Nothing was transferred; make a new request.",
    );
  signal?.throwIfAborted();
  return { source: before.source, target: before.target, sourceKind: before.sourceKind };
}

async function inspectTransfer(
  operation: "copy" | "move",
  source: string,
  target: string,
  cwd: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const resolvedSource = await resolveLeaf(source);
  const resolvedTarget = await resolveLeaf(target);
  const sourceStat = await lstat(resolvedSource);
  const targetStat = await optionalStat(resolvedTarget);
  const sourceKind = kind(sourceStat);
  validatePair(resolvedSource, sourceStat, resolvedTarget, targetStat);
  if (
    sourceKind === "directory" &&
    (contains(resolvedSource, resolvedTarget) || contains(resolvedTarget, resolvedSource))
  )
    fail("OVERLAPPING_PATHS", "Source and target directory trees overlap.");
  if (operation === "move") await assertUnprotectedTransferPath(resolvedSource, cwd, signal);
  if (operation === "move" || sourceKind !== "file")
    await assertUnprotectedTransferPath(resolvedTarget, cwd, signal);
  const entries: unknown[] = [resolvedSource, resolvedTarget];
  await inspectTree(resolvedSource, resolvedTarget, operation === "copy", entries, signal);
  // Move removes the destination as one object; it does not merge child paths.
  if (operation === "move") entries.push(snapshot(targetStat));
  return {
    source: resolvedSource,
    target: resolvedTarget,
    sourceKind,
    targetExists: targetStat !== undefined,
    snapshot: JSON.stringify(entries),
  };
}

async function inspectTree(
  source: string,
  target: string,
  merge: boolean,
  entries: unknown[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sourceStat = await lstat(source);
  const sourceKind = kind(sourceStat);
  const targetStat = merge ? await optionalStat(target) : undefined;
  if (merge) validatePair(source, sourceStat, target, targetStat);
  entries.push(source, snapshot(sourceStat), snapshot(targetStat));
  if (sourceKind === "symlink") entries.push(await readlink(source));
  if (sourceKind !== "directory") return;
  for (const name of (await readdir(source)).sort())
    await inspectTree(path.join(source, name), path.join(target, name), merge, entries, signal);
}

function validatePair(
  source: string,
  sourceStat: Stats,
  target: string,
  targetStat: Stats | undefined,
) {
  if (
    source === target ||
    (targetStat !== undefined &&
      sourceStat.dev === targetStat.dev &&
      sourceStat.ino === targetStat.ino)
  )
    fail("SAME_FILE", "Source and target are the same filesystem object.");
  if (targetStat === undefined) return;
  if (targetStat.isSymbolicLink())
    fail("INVALID_FILE_TYPE", "Transfer destination must not be a symlink.");
  if (kind(sourceStat) !== kind(targetStat))
    fail("INVALID_FILE_TYPE", "Source and target must have the same object type.");
}

function kind(stat: Stats): TransferKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  fail("INVALID_FILE_TYPE", "Transfers support regular files, directories, and symlinks only.");
}

function snapshot(stat: Stats | undefined) {
  return stat === undefined
    ? null
    : [stat.dev, stat.ino, stat.mode, stat.size, stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs];
}

async function optionalStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveLeaf(file: string): Promise<string> {
  return path.join(await resolveParent(path.dirname(file)), path.basename(file));
}

async function resolveParent(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling parent link is not a missing directory that we may create.
    if (await optionalStat(directory)) throw error;
    return path.join(await resolveParent(path.dirname(directory)), path.basename(directory));
  }
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    // This compares containment, not a parent-relative filesystem argument.
    // eslint-disable-next-line repo/no-parent-paths
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
