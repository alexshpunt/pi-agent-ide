import { findSshProcessMetadata } from "#src/backend/process-metadata.js";
import type { SshBackendRegistry } from "#src/backend/registry.js";
import { SshBackendError } from "#src/backend/ssh.js";

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
