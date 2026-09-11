import type { IPty } from "node-pty";
import type { Terminal } from "@xterm/headless";

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
  readonly background: boolean;
  readonly cwd: string;
  readonly shell: ShellProfile;
  readonly startedAt: number;
  readonly cols: number;
  readonly rows: number;
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
  readonly cols: number;
  readonly rows: number;
}
