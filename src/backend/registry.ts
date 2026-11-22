import { resolveRemoteLocation, type RemoteLocation, type SshTargetOs } from "./identity.ts";
import { SshBackend, SshBackendError, type SshTarget } from "./ssh.ts";
import { targetOs } from "./ssh-transport.ts";

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

  /** True when at least one configured target declares this OS. */
  hasTargetOs(os: SshTargetOs): boolean {
    return [...this.#backends.values()].some((backend) => targetOs(backend.target) === os);
  }

  /** Claim SSH resources, reject unknown targets, and leave local/protocol sources alone. */
  resolve(source: string, cwd?: string): ResolvedSshSource | undefined {
    const location = resolveRemoteLocation(
      source,
      cwd,
      (target) => this.#backends.get(target)?.target.os,
    );
    if (!location) return undefined;
    const backend = this.#backends.get(location.target);
    if (!backend) throw new SshBackendError("UNKNOWN_TARGET", location.source, "not-applied");
    return { location, backend };
  }
}
