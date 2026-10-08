import type {
  ApplyFileAccessProvider,
  ApplyFileBackup,
  ApplyFileOperation,
} from "pi-agent-text-editor/api/plugin-protocol";
import { createSshFileOperationResolver } from "./file-operation-resolver.js";
import { validateTransferFile } from "./file-transfer.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError, type SshBackend } from "./ssh.js";

/** Give Apply and its receipt the same owners as ordinary SSH file operations.
 * Byte journals stay on their owning target and never use the text snapshot transport.
 * Restore checks the last captured version; an unobserved mutation is not overwritten.
 */
export function createSshApplyFileAccessProvider(
  registry: SshBackendRegistry,
): ApplyFileAccessProvider & { dispose(): Promise<void> } {
  const liveBackups = new Set<ApplyFileBackup>();
  const provider: ApplyFileAccessProvider = (previous, context) => {
    const versions = new Map<string, string | null>();
    const operate = createSshFileOperationResolver(registry, versions);
    const resolve = (cwd: string, source: string) =>
      registry.resolve(source, cwd)?.location.source ?? previous.resolve(cwd, source);
    const backups = new WeakMap<
      ApplyFileBackup,
      Awaited<ReturnType<SshBackend["captureJournal"]>>
    >();
    const observeVersion = async (source: string) => {
      const owned = registry.resolve(source, context.cwd);
      if (owned === undefined) return;
      try {
        versions.set(
          owned.location.source,
          (await owned.backend.lstat(owned.location.path)).revision,
        );
      } catch (error) {
        if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
        versions.set(owned.location.source, null);
      }
    };
    const capture = async (source: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const owned = registry.resolve(source, context.cwd);
      if (owned === undefined) return previous.capture(source, signal);
      try {
        const journal = await owned.backend.captureJournal(owned.location.path, { signal });
        versions.set(owned.location.source, journal.sourceRevision);
        let releasing: Promise<void> | undefined;
        const backup: ApplyFileBackup = {
          sha256: journal.sha256,
          release() {
            releasing ??= owned.backend
              .releaseJournal(journal.directory)
              .then(() => {
                liveBackups.delete(backup);
              })
              .catch((error: unknown) => {
                releasing = undefined;
                throw error;
              });
            return releasing;
          },
        };
        backups.set(backup, journal);
        liveBackups.add(backup);
        return { path: owned.location.source, existed: true, backup };
      } catch (error) {
        if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
        versions.set(owned.location.source, null);
        return { path: owned.location.source, existed: false };
      }
    };
    const validateFile = async (operation: ApplyFileOperation, cwd: string) => {
      const source = registry.resolve(operation.path, cwd);
      const target =
        "target" in operation && operation.target !== undefined
          ? registry.resolve(operation.target, cwd)
          : undefined;
      if (source === undefined && target === undefined)
        return previous.validateFile(operation, cwd);
      if (
        (operation.kind === "copy" || operation.kind === "move") &&
        (source === undefined ||
          target === undefined ||
          target.location.target !== source.location.target)
      )
        return validateTransferFile(registry, operation, { ...context, cwd });
      if (source === undefined)
        throw new SshBackendError("UNSUPPORTED_SOURCE", operation.path, "not-applied");
      let entry;
      try {
        entry = await source.backend.lstat(source.location.path, context);
      } catch (error) {
        if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
      }
      if (operation.kind === "create") {
        if (entry !== undefined)
          throw new SshBackendError("EEXIST", source.location.source, "not-applied");
        return;
      }
      if (entry === undefined)
        throw new SshBackendError("ENOENT", source.location.source, "not-applied");
      if (entry.kind !== "file")
        throw new SshBackendError("INVALID_FILE_TYPE", source.location.source, "not-applied");
      if (operation.kind === "delete") return;
      if (target === undefined)
        throw new SshBackendError("INVALID_TARGET", source.location.source, "not-applied");
      let destination;
      try {
        destination = await target.backend.lstat(target.location.path, context);
      } catch (error) {
        if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
      }
      if (destination === undefined) return;
      if (destination.kind !== "file")
        throw new SshBackendError("INVALID_FILE_TYPE", target.location.source, "not-applied");
      if (
        destination.identity.device === entry.identity.device &&
        destination.identity.inode === entry.identity.inode
      )
        throw new SshBackendError("SAME_FILE", source.location.source, "not-applied");
      if (operation.overwrite !== true)
        throw new SshBackendError("EEXIST", target.location.source, "not-applied");
    };
    return {
      resolve,
      capture,
      ownerKey(source) {
        const owned = registry.resolve(source, context.cwd);
        if (owned !== undefined) {
          const { id, host, workspace, configFile } = owned.backend.target;
          return JSON.stringify([id, host, workspace, configFile ?? null]);
        }
        return previous.ownerKey?.(source) ?? "local-filesystem";
      },
      async readText(source) {
        const owned = registry.resolve(source, context.cwd);
        if (owned === undefined) return previous.readText(source);
        const snapshot = await owned.backend.read(owned.location.path, context);
        return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
      },
      async restore(state, signal) {
        signal?.throwIfAborted();
        const owned = registry.resolve(state.path, context.cwd);
        if (owned === undefined) return previous.restore(state, signal);
        const expected = versions.get(owned.location.source);
        if (expected === undefined)
          throw new SshBackendError("STALE_SNAPSHOT", owned.location.source, "not-applied");
        if (state.existed) {
          const journal = state.backup === undefined ? undefined : backups.get(state.backup);
          if (journal === undefined)
            throw new SshBackendError("INVALID_SNAPSHOT", owned.location.source, "not-applied");
          await owned.backend.restoreJournal(
            journal.path,
            owned.location.path,
            journal.revision,
            expected,
            {
              signal,
            },
          );
        } else if (expected !== null) {
          await owned.backend.removeEntry(owned.location.path, expected, { signal });
        }
        await observeVersion(owned.location.source);
      },
      validateFile,
      async performFile(operation, cwd) {
        const result = await operate(operation.kind, operation, { ...context, cwd });
        if (result === undefined) return previous.performFile(operation, cwd);
        if (!result.ok)
          throw new SshBackendError(
            result.error?.code ?? "OPERATION_FAILED",
            result.path ?? operation.path,
            result.effect,
          );
        await observeVersion(resolve(cwd, operation.path));
        if (operation.target !== undefined) await observeVersion(resolve(cwd, operation.target));
      },
    };
  };
  return Object.assign(provider, {
    async dispose() {
      const outcomes = await Promise.allSettled([...liveBackups].map((backup) => backup.release()));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      if (failures.length > 0) throw new AggregateError(failures, "SSH journal cleanup failed");
    },
  });
}
