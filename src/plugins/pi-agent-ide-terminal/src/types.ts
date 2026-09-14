import type { IPty } from "node-pty";
import type { Terminal } from "@xterm/headless";

export type TerminalWaitReason = "timeout" | "interactive" | "aborted";
export type TerminalCompletionReason = "timeout";

export type TerminalSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "cancelled"
  | "lost";

export interface ShellProfile {
  readonly executable: string;
  readonly displayName: string;
  readonly family: "posix" | "powershell" | "cmd";
  readonly commandArgs: (command: string) => readonly string[];
}

export interface TerminalSession {
  readonly id: string;
  readonly source: string;
  readonly command: string;
  background: boolean;
  readonly cwd: string;
  readonly shell: ShellProfile;
  readonly startedAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly fullOutputPath: string;
  readonly process?: IPty;
  readonly screen: Terminal;
  status: TerminalSessionStatus;
  endedAt?: number;
  exitCode?: number;
  signal?: number;
  error?: string;
  output: string;
  outputStart: number;
  screenReady: Promise<void>;
  completion: Promise<TerminalSession>;
  resolveCompletion: (session: TerminalSession) => void;
  completionDelivered: boolean;
  waitReason?: TerminalWaitReason;
  completionReason?: TerminalCompletionReason;
  lastActivityAt: number;
}

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly source: string;
  readonly command: string;
  readonly cwd: string;
  readonly shell: string;
  readonly shellFamily: ShellProfile["family"];
  readonly background: boolean;
  readonly status: TerminalSessionStatus;
  readonly waitReason?: TerminalWaitReason;
  readonly completionReason?: TerminalCompletionReason;
  readonly lastActivityAt: number;
  readonly idleMs: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly elapsedMs: number;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly error?: string;
  readonly output: string;
  readonly outputStart: number;
  readonly outputEnd: number;
  readonly truncated: boolean;
  readonly fullOutputPath: string;
  readonly cols: number;
  readonly rows: number;
}
