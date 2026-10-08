import { resolveRemoteLocation, type RemoteLocation } from "./identity.js";
import { SshBackend, SshBackendError, type SshTarget } from "./ssh.js";

/** A canonical remote source and the explicitly configured transport that owns it. */
export interface ResolvedSshSource {
  readonly location: RemoteLocation;
  readonly backend: SshBackend;
}

/** Session-owned targets. Construction and resolution never probe or connect to hosts. */
export class SshBackendRegistry {
  readonly #backends = new Map<string, SshBackend>();

  constructor(targets: readonly SshTarget[]) {
    for (const target of targets) {
      if (this.#backends.has(target.id)) throw new TypeError(`Duplicate SSH target: ${target.id}`);
      this.#backends.set(target.id, new SshBackend(target));
    }
  }

  /** Claim SSH resources, reject unknown targets, and leave local/protocol sources alone. */
  resolve(source: string, cwd?: string): ResolvedSshSource | undefined {
    const location = resolveRemoteLocation(source, cwd);
    if (!location) return undefined;
    const backend = this.#backends.get(location.target);
    if (!backend) throw new SshBackendError("UNKNOWN_TARGET", location.source, "not-applied");
    return { location, backend };
  }
}
