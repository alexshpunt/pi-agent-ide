import { lstat, mkdir, rm, symlink, unlink, open } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { ResourceResolverContext } from "pi-agent-resource";
import {
  localFileTransferAccess,
  type FileObjectEntry,
  type FileOperationInput,
  type FileOperationPolicy,
  type FileOperationResult,
  type FileTransferEndpoint,
} from "pi-agent-text-editor/api/plugin-protocol";
import type { ResolvedSshSource, SshBackendRegistry } from "./registry.js";
import { remoteLocation } from "./identity.js";
import { localTransferSource, transferFile } from "./file-transfer.js";
import { checkCapturedRevision } from "./file-revision.js";
import { SshBackendError } from "./ssh.js";

interface Endpoint extends FileTransferEndpoint {
  readonly remote?: ResolvedSshSource;
  readonly source: string;
}

/** Resolve each endpoint on its selected owner; never interpret SSH paths on the controller. */
function endpoint(
  registry: SshBackendRegistry,
  source: string,
  context: ResourceResolverContext,
): Endpoint {
  const remote = registry.resolve(source, context.cwd);
  if (remote === undefined) {
    const file = localTransferSource(source, context.cwd);
    return { path: file, source: file, cwd: context.cwd, files: localFileTransferAccess };
  }
  const project = registry.resolve(context.cwd, context.cwd);
  const cwd =
    project?.location.target === remote.location.target
      ? project.location.path
      : remote.backend.target.workspace;
  return {
    remote,
    source: remote.location.source,
    path: remote.location.path,
    cwd,
    files: {
      owner: JSON.stringify([remote.backend.target.host, remote.backend.target.configFile ?? null]),
      realpath: (file) => remote.backend.realpath(file, context),
      inspect: (file) => remote.backend.lstat(file, context),
      read: async (file) => (await remote.backend.read(file, context)).bytes.toString("utf8"),
      git: (directory, args, signal) =>
        remote.backend.queryGit(directory, args, { ...context, signal }),
      source: (file) => remoteLocation(remote.location.target, file).source,
      snapshot: (file, signal) => remote.backend.objectSnapshot(file, { ...context, signal }),
    },
  };
}

function leaf(owner: Endpoint, root: string, relative: string): string {
  const paths = owner.remote ? path.posix : path;
  // POSIX names containing a backslash must not become Windows path components.
  if (
    paths.sep === "\\" &&
    relative.split("/").some((name) => name.includes("\\") || name.includes(":"))
  )
    throw new SshBackendError("INVALID_TARGET", owner.source, "not-applied");
  return paths.join(root, ...relative.split("/"));
}

function receiptPath(owner: Endpoint, native: string): string {
  return owner.remote ? remoteLocation(owner.remote.location.target, native).source : native;
}

async function checkEntry(owner: Endpoint, file: string, expected: FileObjectEntry | undefined) {
  let info;
  try {
    info = await owner.files.inspect(file);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (expected === undefined) return;
    } else throw error;
  }
  if (expected === undefined || info?.revision !== expected.revision)
    throw new SshBackendError("TRANSFER_TARGET_CHANGED", receiptPath(owner, file), "not-applied");
}

async function directoryParents(directory: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await directoryParents(path.dirname(directory));
    await mkdir(directory);
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new SshBackendError("INVALID_FILE_TYPE", directory, "not-applied");
  if (path.dirname(directory) !== directory) await directoryParents(path.dirname(directory));
}

async function remove(
  owner: Endpoint,
  file: string,
  entry: FileObjectEntry,
  context: ResourceResolverContext,
) {
  if (owner.remote) await owner.remote.backend.removeObject(file, entry.revision, context);
  else {
    await checkEntry(owner, file, entry);
    if (entry.kind === "directory") await rm(file, { recursive: true, force: false });
    else await unlink(file);
  }
}

/** Copy/Move native objects across every supported owner pair.
 * All trees and removal approvals are checked before effects. Cross-owner Move publishes first,
 * then rechecks and removes the source. It has no rollback; any late failure is unknown.
 */
export async function transferObject(
  registry: SshBackendRegistry,
  operation: "copy" | "move",
  input: FileOperationInput,
  context: ResourceResolverContext,
  policy: FileOperationPolicy,
  captured?: ReadonlyMap<string, string | null>,
): Promise<FileOperationResult> {
  const source = endpoint(registry, input.path, context);
  const target = endpoint(registry, input.target ?? "", context);
  const guard = await policy.prepareTransfer(operation, source, target);
  const root = guard.source.entries[0];
  if (root === undefined) throw new SshBackendError("ENOENT", source.source, "not-applied");
  if (source.remote) checkCapturedRevision(source.source, root.revision, captured);
  if (target.remote)
    checkCapturedRevision(target.source, guard.target.entries[0]?.revision ?? null, captured);
  let started = false;
  try {
    context.signal?.throwIfAborted();
    // Reject unrepresentable destination names before any root or child is published.
    for (const entry of guard.source.entries) {
      leaf(source, guard.source.path, entry.relativePath);
      leaf(target, guard.target.path, entry.relativePath);
    }
    if (guard.sourceKind === "file") {
      // Keep the established native regular-file path and its same-filesystem inode behavior.
      if (
        source.remote &&
        target.remote &&
        source.remote.location.target === target.remote.location.target
      ) {
        await source.remote.backend[operation](
          guard.source.path,
          guard.target.path,
          root.revision,
          guard.target.entries[0]?.revision ?? null,
          context,
        );
      } else {
        await transferFile(registry, operation, input, context, captured, async () => {
          await checkEntry(source, guard.source.path, root);
          await checkEntry(target, guard.target.path, guard.target.entries[0]);
        });
      }
    } else {
      if (
        operation === "move" &&
        source.remote &&
        target.remote &&
        source.files.owner === target.files.owner
      ) {
        if (await source.remote.backend.moveObject(guard.source, guard.target, context))
          return {
            kind: "file-operation",
            operation,
            ok: true,
            effect: "applied",
            path: source.source,
            target: target.source,
            sourceKind: guard.sourceKind,
          };
      }
      const destination = new Map(guard.target.entries.map((entry) => [entry.relativePath, entry]));
      const createdDirectories = new Map<string, FileObjectEntry["identity"]>();
      if (operation === "move" && guard.target.entries[0]) {
        started = true;
        await remove(target, guard.target.path, guard.target.entries[0], context);
        destination.clear();
      }
      for (const entry of guard.source.entries) {
        context.signal?.throwIfAborted();
        const from = leaf(source, guard.source.path, entry.relativePath);
        const to = leaf(target, guard.target.path, entry.relativePath);
        await checkEntry(source, from, entry);
        const expected = destination.get(entry.relativePath);
        await checkEntry(target, to, expected);
        if (entry.kind === "directory") {
          if (expected === undefined) started = true;
          if (target.remote)
            await target.remote.backend.ensureObjectDirectory(
              to,
              entry.mode | 0o700,
              expected?.revision ?? null,
              context,
            );
          else if (expected === undefined) {
            await directoryParents(path.dirname(to));
            await mkdir(to, { mode: entry.mode | 0o700 });
          }
          if (expected === undefined)
            createdDirectories.set(entry.relativePath, (await target.files.inspect(to)).identity);
        } else if (entry.kind === "symlink") {
          started = true;
          if (entry.link === undefined)
            throw new SshBackendError("INVALID_RESPONSE", source.source, "unknown");
          if (target.remote) await target.remote.backend.createObjectLink(to, entry.link, context);
          else {
            await directoryParents(path.dirname(to));
            await symlink(Buffer.from(entry.link, "base64"), to);
          }
        } else {
          started = true;
          const fromSource = receiptPath(source, from);
          const toSource = receiptPath(target, to);
          if (source.remote && target.remote && source.files.owner === target.files.owner)
            await source.remote.backend.copy(
              from,
              to,
              entry.revision,
              expected?.revision ?? null,
              context,
            );
          else
            await transferFile(
              registry,
              "copy",
              { path: fromSource, target: toSource },
              context,
              undefined,
              async () => {
                await checkEntry(source, from, entry);
                await checkEntry(target, to, expected);
              },
            );
        }
      }
      // Child creation changes directory revisions. Check its present identity before mode publication.
      for (const entry of [...guard.source.entries].reverse()) {
        if (entry.kind !== "directory" || destination.has(entry.relativePath)) continue;
        const to = leaf(target, guard.target.path, entry.relativePath);
        const current = await target.files.inspect(to);
        const created = createdDirectories.get(entry.relativePath);
        if (
          current.kind !== "directory" ||
          created?.device !== current.identity.device ||
          created.inode !== current.identity.inode
        )
          throw new SshBackendError("TRANSFER_TARGET_CHANGED", target.source, "unknown");
        if (target.remote)
          await target.remote.backend.setObjectMode(to, entry.mode, current.revision, context);
        else {
          const fd = await open(
            to,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            const info = await fd.stat();
            if (String(info.dev) !== created.device || String(info.ino) !== created.inode)
              throw new SshBackendError("TRANSFER_TARGET_CHANGED", target.source, "unknown");
            await fd.chmod(entry.mode & 0o7777);
          } finally {
            await fd.close();
          }
        }
      }
      await guard.verifySource();
      if (operation === "move") await remove(source, guard.source.path, root, context);
    }
    return {
      kind: "file-operation",
      operation,
      ok: true,
      effect: "applied",
      path: source.source,
      target: target.source,
      sourceKind: guard.sourceKind,
    };
  } catch (error) {
    if (started)
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        effect: "unknown",
      });
    throw error;
  }
}
