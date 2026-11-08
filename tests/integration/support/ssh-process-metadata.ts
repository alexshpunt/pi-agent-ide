import { findSshProcessMetadata } from "#src/backend/process-metadata.ts";
import type { SshBackendRegistry } from "#src/backend/registry.ts";
import { SshBackendError } from "#src/backend/ssh.ts";

export { findSshProcessMetadata };

/** Check one fixture-owned PID when verifying cleanup; this is not process discovery. */
export async function readSshProcessMetadata(
  registry: SshBackendRegistry,
  scope: string,
  pid: number,
  signal?: AbortSignal,
) {
  const snapshot = await findSshProcessMetadata(registry, scope, pid, signal);
  if (snapshot === undefined) throw new SshBackendError("ENOENT", scope, "not-applied");
  return [snapshot];
}
