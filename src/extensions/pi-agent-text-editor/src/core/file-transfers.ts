import path from "node:path";
import { localFileTransferAccess } from "#src/api/native-files.ts";
import type {
  FileObjectEntry,
  FileObjectSnapshot,
  FileTransferEndpoint,
  FileTransferGuard,
} from "#src/api/file-transfers.ts";
import {
  assertUnprotectedTransferPath,
  prepareDeletionGuards,
  projectLookup,
  settleInOrder,
  type DeletePolicyContext,
  type DeletionGuard,
} from "./delete-policy.ts";

/** Object kinds supported by byte-preserving whole-object transfers. */
export type TransferKind = "file" | "directory" | "symlink";

/** Local transfers use the same owner-aware preflight as local/SSH and target/target transfers. */
export async function prepareFileTransfer(
  operation: "copy" | "move",
  source: string,
  target: string,
  cwd: string,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<{ source: string; target: string; sourceKind: TransferKind }> {
  const guard = await prepareObjectTransfer(
    operation,
    { path: source, cwd, files: localFileTransferAccess },
    { path: target, cwd, files: localFileTransferAccess },
    context,
    signal,
  );
  return { source: guard.source.path, target: guard.target.path, sourceKind: guard.sourceKind };
}

/** Check both native owners, obtain removal approvals, and recheck all participants before effects. */
export async function prepareObjectTransfer(
  operation: "copy" | "move",
  source: FileTransferEndpoint,
  target: FileTransferEndpoint,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<FileTransferGuard> {
  signal?.throwIfAborted();
  const before = await inspectTransfer(operation, source, target, signal);
  // Removal approvals: the moved source first, then a replaced destination tree.
  const guards: DeletionGuard[] =
    operation === "move" && before.sourceKind !== "file"
      ? await prepareDeletionGuards(
          [
            { source: source.path, cwd: source.cwd, context: { ...context, files: source.files } },
            // A case-only rename's target is the source itself; it is never removed.
            ...(before.target.entries.length > 0 && !before.caseRename
              ? [{ source: target.path, cwd: target.cwd, context: { ...context, files: target.files } }]
              : []),
          ],
          signal,
        )
      : [];
  const sourceGuard = guards[0];
  // Rechecks only read, so they run together; a guard failure still comes first.
  const recheck = inspectTransfer(operation, source, target, signal);
  await settleInOrder([...guards.map((guard) => guard.verify()), recheck]);
  const after = await recheck;
  if (JSON.stringify(before) !== JSON.stringify(after))
    fail(
      "TRANSFER_TARGET_CHANGED",
      "Transfer paths or contents changed during preflight. Nothing was transferred; make a new request.",
    );
  signal?.throwIfAborted();
  return {
    source: before.source,
    target: before.target,
    sourceKind: before.sourceKind,
    async verifySource() {
      signal?.throwIfAborted();
      const snapshot = source.files.snapshot(source.path, signal);
      await settleInOrder([sourceGuard?.verify() ?? Promise.resolve(), snapshot]);
      if (JSON.stringify(await snapshot) !== JSON.stringify(before.source))
        fail(
          "TRANSFER_TARGET_CHANGED",
          "Transfer source changed before removal; inspect both endpoints before retrying.",
        );
    },
  };
}

async function inspectTransfer(
  operation: "copy" | "move",
  source: FileTransferEndpoint,
  target: FileTransferEndpoint,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  // One lookup per owner serves all four protection checks of this pass.
  const projects = projectLookup(signal);
  const protect = (endpoint: FileTransferEndpoint, file: string) =>
    assertUnprotectedTransferPath(file, endpoint.cwd, signal, endpoint.files, projects);
  // Reject protected roots before walking a potentially large tree. A Move checks both roots
  // beside the source inspection; a Copy checks its target only when the source is a tree.
  const inspection = source.files.inspect(source.path);
  const roots = operation === "move" ? [protect(source, source.path), protect(target, target.path)] : [];
  await settleInOrder([inspection, ...roots]);
  const root = await inspection;
  if (operation === "copy" && root.kind !== "file") await protect(target, target.path);
  const nativePaths = source.files.pathStyle === "native" ? path : path.posix;
  if (
    source.files.owner === target.files.owner &&
    root.kind === "directory" &&
    (contains(source.path, target.path, nativePaths) ||
      contains(target.path, source.path, nativePaths))
  )
    fail("OVERLAPPING_PATHS", "Source and target directory trees overlap.");
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    source.files.snapshot(source.path, signal),
    target.files.snapshot(target.path, signal),
  ]);
  validateSnapshot(sourceSnapshot, true);
  validateSnapshot(targetSnapshot, false);
  const sourceRoot = sourceSnapshot.entries[0];
  if (sourceRoot === undefined) fail("ENOENT", "Transfer source does not exist.");
  const targetRoot = targetSnapshot.entries[0];
  const sameOwner = source.files.owner === target.files.owner;
  const paths = source.files.pathStyle === "native" ? path : path.posix;
  // On a case-insensitive volume, renaming to another spelling of the same name is a real move.
  const caseRename =
    operation === "move" &&
    sameOwner &&
    source.files.caseInsensitive === true &&
    isCaseRename(sourceSnapshot.path, targetSnapshot.path, paths);
  validatePair(sourceRoot, targetRoot, sameOwner, caseRename);
  if (sameOwner && sourceSnapshot.path === targetSnapshot.path)
    fail("SAME_FILE", "Source and target are the same filesystem object.");
  if (
    sameOwner &&
    sourceRoot.kind === "directory" &&
    (contains(sourceSnapshot.path, targetSnapshot.path, paths) ||
      contains(targetSnapshot.path, sourceSnapshot.path, paths))
  )
    fail("OVERLAPPING_PATHS", "Source and target directory trees overlap.");
  if (operation === "move") await protect(source, sourceSnapshot.path);
  if (operation === "move" || sourceRoot.kind !== "file") await protect(target, targetSnapshot.path);
  if (operation === "copy") {
    const destination = new Map(targetSnapshot.entries.map((entry) => [entry.relativePath, entry]));
    for (const entry of sourceSnapshot.entries)
      validatePair(entry, destination.get(entry.relativePath), sameOwner);
  }
  if (sourceRoot.kind === "other")
    fail("INVALID_FILE_TYPE", "Transfers support regular files, directories, and symlinks only.");
  return {
    source: sourceSnapshot,
    target: targetSnapshot,
    sourceKind: sourceRoot.kind,
    caseRename,
  };
}

function isCaseRename(from: string, to: string, paths: typeof path): boolean {
  return (
    from !== to &&
    from.toLowerCase() === to.toLowerCase() &&
    paths.basename(from) !== paths.basename(to)
  );
}

function validateSnapshot(snapshot: FileObjectSnapshot, source: boolean): void {
  const paths = new Set<string>();
  for (const [index, entry] of snapshot.entries.entries()) {
    if (
      (index === 0 && entry.relativePath !== "") ||
      paths.has(entry.relativePath) ||
      entry.relativePath.includes("\0") ||
      path.posix.isAbsolute(entry.relativePath) ||
      (entry.relativePath !== "" &&
        // This rejects traversal returned by a provider, not a parent-relative path argument.
        // eslint-disable-next-line repo/no-parent-paths
        entry.relativePath.split("/").some((part) => part === "" || part === "." || part === ".."))
    )
      fail("INVALID_PROVIDER_RESULT", "Transfer snapshot contains an unsafe or duplicate path.");
    paths.add(entry.relativePath);
    if (source && entry.kind === "other")
      fail("INVALID_FILE_TYPE", "Transfers support regular files, directories, and symlinks only.");
    if (
      entry.kind === "symlink" &&
      (entry.link === undefined ||
        Buffer.from(entry.link, "base64").toString("base64") !== entry.link)
    )
      fail("INVALID_PROVIDER_RESULT", "Transfer symlink has no valid original link bytes.");
  }
}

function validatePair(
  source: FileObjectEntry,
  target: FileObjectEntry | undefined,
  sameOwner: boolean,
  caseRename = false,
) {
  if (target === undefined) return;
  if (
    sameOwner &&
    !caseRename &&
    source.identity.device === target.identity.device &&
    source.identity.inode === target.identity.inode
  )
    fail("SAME_FILE", "Source and target are the same filesystem object.");
  if (target.kind === "symlink")
    fail("INVALID_FILE_TYPE", "Transfer destination must not be a symlink.");
  if (source.kind !== target.kind)
    fail("INVALID_FILE_TYPE", "Source and target must have the same object type.");
}

function contains(parent: string, child: string, paths: typeof path) {
  const relative = paths.relative(parent, child);
  return (
    relative === "" ||
    // This compares containment, not a parent-relative filesystem argument.
    // eslint-disable-next-line repo/no-parent-paths
    (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
  );
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, effect: "not-applied" });
}
