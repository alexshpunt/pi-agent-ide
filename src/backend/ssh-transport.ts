import { readFile } from "node:fs/promises";
import type { SshTarget } from "./ssh.js";
import { remoteLocation } from "./identity.js";

/** Validate configured aliases without reading credentials or probing the host. */
export function validateSshTarget(target: SshTarget): void {
  remoteLocation(target.id, target.workspace);
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(target.host))
    throw new TypeError("SSH host must be an OpenSSH host alias, not a command or URI");
}

/** Fixed Python program shared by direct argv and shell bootstrap transports. */
export async function sshWorkerProgram(worker: URL): Promise<string> {
  const bytes = await readFile(worker);
  return `exec(__import__("base64").b64decode("${bytes.toString("base64")}"))`;
}

/** Fixed bootstrap; request data belongs on stdin, never in interpolated shell source. */
export async function sshWorkerCommand(worker: URL): Promise<string> {
  return `python3 -c '${await sshWorkerProgram(worker)}'`;
}

/** Safe system OpenSSH options shared by short operations and service channels. */
export function systemSshArguments(target: SshTarget, command: string): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (target.configFile !== undefined) args.push("-F", target.configFile);
  args.push("--", target.host, command);
  return args;
}

/** Classify bounded SSH diagnostics without returning their text or credential paths. */
export function sshFailureCode(exitCode: number | null, stderr: string): string {
  return /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/u.test(
    stderr,
  )
    ? "HOST_KEY_FAILED"
    : /Permission denied \([^)]*\)/u.test(stderr)
      ? "AUTH_FAILED"
      : exitCode === 127 && /\bpython3:\s*(?:command\s+)?not found\b/u.test(stderr)
        ? "DEPENDENCY_UNAVAILABLE"
        : "TRANSPORT_FAILED";
}
