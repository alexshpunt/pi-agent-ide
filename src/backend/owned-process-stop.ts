import { findSshProcessMetadata } from "./process-metadata.ts";
import type { SshBackendRegistry } from "./registry.ts";
import type { SshProcessChannel } from "./ssh-channel.ts";
import { SshBackendError } from "./ssh.ts";

/** Stop an owned service; after carrier loss, confirm its exact native identity through a new connection.
 * Only native absence or PID reuse proves the original process is gone. Never signal a replacement.
 */
export async function stopOwnedSshProcess(
  channel: Pick<SshProcessChannel, "stop" | "pid" | "identity">,
  registry: SshBackendRegistry,
  source: string,
): Promise<void> {
  try {
    await channel.stop();
  } catch (error) {
    if (
      !(error instanceof SshBackendError) ||
      error.code !== "TRANSPORT_FAILED" ||
      !channel.identity
    )
      throw error;
    let native;
    try {
      native = await findSshProcessMetadata(registry, source, channel.pid);
    } catch (inspectionError) {
      throw new AggregateError(
        [error, inspectionError],
        "Owned SSH cleanup could not be reconciled",
        { cause: inspectionError },
      );
    }
    if (native === undefined || native.identity !== channel.identity) return;
    throw error;
  }
}
