import type { FileOperationResolver } from "pi-agent-text-editor/api/plugin-protocol";

import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { transferObject } from "./object-transfer.js";
import { checkCapturedRevision } from "./file-revision.js";
import { remoteLocation } from "./identity.js";

/** Route owned whole-file operations without text conversion or local path fallback. */
export function createSshFileOperationResolver(
  registry: SshBackendRegistry,
  captured?: ReadonlyMap<string, string | null>,
): FileOperationResolver {
  return async (operation, input, context, deletion) => {
    const source = registry.resolve(input.path, context.cwd);
    if (
      source === undefined &&
      (input.target === undefined || registry.resolve(input.target, context.cwd) === undefined)
    )
      return undefined;
    if (operation !== "delete") {
      if (deletion === undefined)
        throw new SshBackendError("TRANSFER_POLICY_REQUIRED", input.path, "not-applied");
      return transferObject(registry, operation, input, context, deletion, captured);
    }
    if (source === undefined) return undefined;
    const entry = await source.backend.lstat(source.location.path, context);
    checkCapturedRevision(source.location.source, entry.revision, captured);
    {
      if (deletion === undefined)
        throw new SshBackendError("DELETE_POLICY_REQUIRED", source.location.source, "not-applied");
      const project = registry.resolve(context.cwd, context.cwd);
      if (project !== undefined && project.location.target !== source.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", source.location.source, "not-applied");
      const cwd = project?.location.path ?? source.backend.target.workspace;
      const prepared = await deletion.prepare(source.location.path, cwd, {
        temporaryEnvironment: (signal) =>
          source.backend.temporaryEnvironment({ ...context, signal }),
        realpath: (file) => source.backend.realpath(file, context),
        inspect: (file) => source.backend.lstat(file, context),
        read: async (file) => (await source.backend.read(file, context)).bytes.toString("utf8"),
        git: (directory, args, signal) =>
          source.backend.queryGit(directory, args, { ...context, signal }),
        source: (file) => remoteLocation(source.location.target, file).source,
      });
      if (prepared.revision !== entry.revision)
        throw new SshBackendError("DELETE_TARGET_CHANGED", source.location.source, "not-applied");
      await source.backend.removeObject(prepared.resolvedPath, prepared.revision, context);
      return {
        kind: "file-operation",
        operation,
        ok: true,
        effect: "applied",
        path: source.location.source,
      };
    }
  };
}
