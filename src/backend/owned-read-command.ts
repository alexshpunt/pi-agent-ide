import { runOwnedSshCommand } from "./owned-command.ts";
import type { SshTarget } from "./ssh.ts";
import type { SshCommand } from "./ssh-transport.ts";

/** Bounds for one owned, buffered read service. Both output streams share the byte budget. */
export interface OwnedReadCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** Run a read-only target service and await native cleanup without changing its execution owner. */
export async function readOwnedSshCommand(
  target: SshTarget,
  command: SshCommand,
  args: readonly string[],
  source: string,
  options: OwnedReadCommandOptions,
): Promise<{ stdout: Buffer; exitCode: number }> {
  return runOwnedSshCommand(target, command, args, source, { ...options, effect: "not-applied" });
}
