import { SshBackendError } from "./ssh.js";

/** Keep a checkpoint revision authoritative when an effect obtains fresh metadata.
 * This check does not replace the owner's final publication guard or provide external CAS.
 */
export function checkCapturedRevision(
  source: string,
  current: string | null,
  captured?: ReadonlyMap<string, string | null>,
): void {
  if (captured?.has(source) && captured.get(source) !== current)
    throw new SshBackendError("CONFLICT", source, "not-applied");
}
