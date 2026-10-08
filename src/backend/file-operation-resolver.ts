import type { FileOperationResolver } from "pi-agent-text-editor/api/plugin-protocol";

import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { transferFile } from "./file-transfer.js";
import { checkCapturedRevision } from "./file-revision.js";

/** Route owned whole-file operations without text conversion or local path fallback. */
export function createSshFileOperationResolver(
  registry: SshBackendRegistry,
  captured?: ReadonlyMap<string, string | null>,
): FileOperationResolver {
  return async (operation, input, context) => {
    const source = registry.resolve(input.path, context.cwd);
    const target =
      input.target === undefined ? undefined : registry.resolve(input.target, context.cwd);
    if (source === undefined && target === undefined) return undefined;
    if (
      operation !== "delete" &&
      (source === undefined ||
        target === undefined ||
        target.location.target !== source.location.target)
    ) {
      const transferred = await transferFile(registry, operation, input, context, captured);
      return {
        kind: "file-operation",
        operation,
        ok: true,
        effect: "applied",
        path: transferred.source,
        target: transferred.target,
      };
    }
    if (source === undefined) return undefined;
    const entry = await source.backend.lstat(source.location.path, context);
    checkCapturedRevision(source.location.source, entry.revision, captured);
    if (entry.kind !== "file")
      throw new SshBackendError("INVALID_FILE_TYPE", source.location.source, "not-applied");
    if (operation === "delete") {
      await source.backend.removeEntry(source.location.path, entry.revision, context);
      return {
        kind: "file-operation",
        operation,
        ok: true,
        effect: "applied",
        path: source.location.source,
      };
    }
    if (target === undefined)
      throw new SshBackendError("INVALID_TARGET", source.location.source, "not-applied");
    let destination;
    try {
      destination = await target.backend.lstat(target.location.path, context);
    } catch (error) {
      if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
    }
    checkCapturedRevision(target.location.source, destination?.revision ?? null, captured);
    if (destination !== undefined) {
      if (destination.kind !== "file")
        throw new SshBackendError("INVALID_FILE_TYPE", target.location.source, "not-applied");
      if (
        destination.identity.device === entry.identity.device &&
        destination.identity.inode === entry.identity.inode
      )
        throw new SshBackendError("SAME_FILE", source.location.source, "not-applied");
      if (input.overwrite !== true)
        throw new SshBackendError("EEXIST", target.location.source, "not-applied");
    }
    await source.backend[operation](
      source.location.path,
      target.location.path,
      entry.revision,
      destination?.revision ?? null,
      context,
    );
    return {
      kind: "file-operation",
      operation,
      ok: true,
      effect: "applied",
      path: source.location.source,
      target: target.location.source,
    };
  };
}
