import { runOwnedSshCommand } from "./owned-command.js";
import type { SshTarget } from "./ssh.js";

/** Bounds for one owned, buffered read service. Both output streams share the byte budget. */
export interface OwnedReadCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** Run a read-only target service and await native cleanup without changing its execution owner. */
export async function readOwnedSshCommand(
  target: SshTarget,
  command: string,
  args: readonly string[],
  source: string,
  options: OwnedReadCommandOptions,
): Promise<{ stdout: Buffer; exitCode: number }> {
  return runOwnedSshCommand(target, command, args, source, { ...options, effect: "not-applied" });
}
