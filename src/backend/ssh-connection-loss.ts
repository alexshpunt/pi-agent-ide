/** Why an SSH connection ended without the command's exit status, from a fixed vocabulary. */
export type SshConnectionLossReason =
  | "keepalive-timeout"
  | "reset"
  | "closed-by-target"
  | "broken-pipe"
  | "timed-out"
  | "refused"
  | "unreachable"
  | "unresolved"
  | "stop-unconfirmed"
  | "signal"
  | "unexplained";

/** How far the channel got: while connecting, the target has run nothing yet. */
export type SshConnectionPhase = "connecting" | "starting" | "running";

/** Sanitized facts about a lost connection. Never carries OpenSSH's own text. */
export interface SshConnectionLoss {
  readonly reason: SshConnectionLossReason;
  readonly phase: SshConnectionPhase;
  /** From the start of the connection attempt to the loss. */
  readonly afterMs: number;
  /** Since the last bytes arrived from the target; absent when nothing arrived. */
  readonly silentMs?: number;
}

/** OpenSSH prints this at LogLevel VERBOSE once user authentication succeeds (7.4 and later). */
const AUTHENTICATED = /^Authenticated to /mu;

/** True when OpenSSH's diagnostics show that user authentication succeeded. */
export function sshAuthenticated(stderr: string): boolean {
  return AUTHENTICATED.test(stderr);
}

/** OpenSSH's own wording for each way a connection can end. */
const lossPatterns: readonly (readonly [SshConnectionLossReason, RegExp])[] = [
  ["keepalive-timeout", /Timeout, server .* not responding/u],
  ["reset", /Connection reset/u],
  ["closed-by-target", /Connection closed by|closed by remote host/u],
  ["broken-pipe", /Broken pipe/u],
  ["timed-out", /(?:Connection|Operation) timed out/u],
  ["refused", /Connection refused/u],
  ["unreachable", /No route to host|Network is unreachable|Host is down/u],
  ["unresolved", /Could not resolve hostname/u],
];

/** Classify OpenSSH's final diagnostics. The last matching line wins: earlier lines can be
 * remote shell noise, and OpenSSH reports the end of the connection last. */
export function sshConnectionLossReason(
  exitCode: number | null,
  stderr: string,
): SshConnectionLossReason {
  const lines = stderr.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    for (const [reason, pattern] of lossPatterns) if (pattern.test(line)) return reason;
  }
  return exitCode === null ? "signal" : "unexplained";
}

/** OpenSSH logs the totals of a connection once it has ended. */
const ENDED = /^Transferred: /mu;

/** Classify the log of the master a process went through. A master runs in the background
 * without stderr, where OpenSSH reports that the target closed the connection, so a log that
 * shows the end of the connection and no other reason means that. */
export function sshMasterConnectionLossReason(log: string): SshConnectionLossReason {
  const reason = sshConnectionLossReason(0, log);
  return reason === "unexplained" && ENDED.test(log) ? "closed-by-target" : reason;
}

const transientReasons: ReadonlySet<SshConnectionLossReason> = new Set([
  "keepalive-timeout",
  "reset",
  "closed-by-target",
  "broken-pipe",
  "timed-out",
  "unreachable",
]);

/** True for losses the network causes and can clear a moment later. A refused port, an unknown
 * host name or an unexplained failure such as a configuration error repeats on another attempt. */
export function sshConnectionLossTransient(reason: SshConnectionLossReason): boolean {
  return transientReasons.has(reason);
}

const reasons: Readonly<Record<SshConnectionLossReason, string>> = {
  "keepalive-timeout":
    "the target stopped answering keepalive probes, so this side closed the connection",
  reset: "the connection was reset (by the target or the network)",
  "closed-by-target": "the target closed the connection",
  "broken-pipe": "the connection broke as this side sent data to the target",
  "timed-out": "the network stopped delivering data (TCP timed out)",
  refused: "the target refused the connection",
  unreachable: "the network has no route to the target",
  unresolved: "the host name did not resolve",
  "stop-unconfirmed":
    "the target did not confirm a stop in time, so this side closed the connection",
  signal: "the local SSH client was killed by a signal",
  unexplained: "the SSH connection ended without the command's exit status",
};

const phases: Readonly<Record<SshConnectionPhase, string>> = {
  connecting: "while connecting",
  starting: "while the command was starting",
  running: "while the command was running",
};

function seconds(milliseconds: number): string {
  const value = milliseconds / 1000;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
}

/** One sentence for an error message: what happened, when, and how long the link was silent. */
export function describeSshConnectionLoss(loss: SshConnectionLoss): string {
  const silent =
    loss.silentMs !== undefined && loss.silentMs >= 1000
      ? `; nothing had arrived from the target for ${seconds(loss.silentMs)} before that`
      : "";
  const effect = loss.phase === "connecting" ? "; nothing ran on the target" : "";
  return `${reasons[loss.reason]} ${phases[loss.phase]}, ${seconds(loss.afterMs)} after the connection attempt began${silent}${effect}`;
}
