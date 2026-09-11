import { spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import type { Terminal as XtermTerminal } from "@xterm/headless";
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";

import type {
  ShellProfile,
  TerminalSession,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const require = createRequire(import.meta.url);
const MAX_OUTPUT_CHARS = 1_000_000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const STOP_GRACE_MS = 2_000;

type SessionListener = (session: TerminalSession) => void;

/** Owns live PTYs, bounded output, virtual screens, and process-tree termination. */
export class TerminalSessionManager {
  readonly #createId: () => string;
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #changeListeners = new Set<SessionListener>();
  readonly #completionListeners = new Set<SessionListener>();
  #disposed = false;

  public constructor(createId: () => string = defaultSessionId) {
    this.#createId = createId;
  }

  public onDidChange(listener: SessionListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  public onDidComplete(listener: SessionListener): () => void {
    this.#completionListeners.add(listener);
    return () => this.#completionListeners.delete(listener);
  }

  public list(): readonly TerminalSessionSnapshot[] {
    return [...this.#sessions.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((session) => this.snapshot(session));
  }

  public get(sourceOrId: string): TerminalSession | undefined {
    return this.#sessions.get(normalizeSessionId(sourceOrId));
  }

  public snapshot(session: TerminalSession, now = Date.now()): TerminalSessionSnapshot {
    return {
      id: session.id,
      source: session.source,
      command: session.command,
      cwd: session.cwd,
      shell: session.shell.displayName,
      shellFamily: session.shell.family,
      background: session.background,
      status: session.status,
      startedAt: session.startedAt,
      ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
      elapsedMs: (session.endedAt ?? now) - session.startedAt,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      ...(session.signal === undefined ? {} : { signal: session.signal }),
      ...(session.error === undefined ? {} : { error: session.error }),
      output: session.output,
      outputStart: session.outputStart,
      outputEnd: session.outputStart + session.output.length,
      truncated: session.outputStart > 0,
      cols: session.cols,
      rows: session.rows,
    };
  }

  public start(options: {
    readonly command: string;
    readonly background: boolean;
    readonly cwd: string;
    readonly shell: ShellProfile;
    readonly cols?: number;
    readonly rows?: number;
  }): TerminalSession {
    if (this.#disposed) throw new Error("Terminal session manager is closed");
    const id = this.#createId();
    if (!/^[a-f\d]{12}$/u.test(id) || this.#sessions.has(id)) {
      throw new Error("Terminal session IDs must be unique 12-character hexadecimal values");
    }
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const screen = createScreen(cols, rows);
    let resolveCompletion = (_session: TerminalSession): void => {};
    const completion = new Promise<TerminalSession>((resolve) => {
      resolveCompletion = resolve;
    });
    const base = {
      id,
      source: `shell:${id}`,
      command: options.command,
      background: options.background,
      cwd: options.cwd,
      shell: options.shell,
      startedAt: Date.now(),
      cols,
      rows,
      screen,
      status: "running" as const,
      output: "",
      outputStart: 0,
      screenReady: Promise.resolve(),
      completion,
      resolveCompletion,
      completionDelivered: false,
    };

    let process: IPty;
    try {
      const pty = require("node-pty") as {
        spawn(
          executable: string,
          args: string[],
          options: IPtyForkOptions | IWindowsPtyForkOptions,
        ): IPty;
      };
      const ptyOptions: IPtyForkOptions | IWindowsPtyForkOptions = {
        name: "xterm-256color",
        cols,
        rows,
        cwd: options.cwd,
        env: cleanEnvironment(processEnvironment()),
      };
      process = pty.spawn(
        options.shell.executable,
        [...options.shell.commandArgs(options.command)],
        ptyOptions,
      );
    } catch (error) {
      const session: TerminalSession = {
        ...base,
        status: "failed",
        endedAt: Date.now(),
        error: errorMessage(error),
      };
      this.#sessions.set(id, session);
      resolveCompletion(session);
      queueMicrotask(() => this.#emitCompleted(session));
      return session;
    }

    const session: TerminalSession = { ...base, process };
    this.#sessions.set(id, session);
    process.onData((data) => this.#appendOutput(session, data));
    process.onExit(({ exitCode, signal }) => {
      if (isTerminalStatus(session.status)) return;
      session.endedAt = Date.now();
      session.exitCode = exitCode;
      if (signal !== 0) session.signal = signal;
      session.status =
        session.status === "stopping" ? "stopped" : exitCode === 0 ? "completed" : "failed";
      session.resolveCompletion(session);
      this.#emitChanged(session);
      this.#emitCompleted(session);
    });
    this.#emitChanged(session);
    return session;
  }

  public async wait(sourceOrId: string, signal?: AbortSignal): Promise<TerminalSession> {
    const session = this.required(sourceOrId);
    if (isTerminalStatus(session.status)) return session;
    if (signal?.aborted === true) {
      await this.stop(session.source, "cancelled");
      return session;
    }
    return await new Promise<TerminalSession>((resolve, reject) => {
      const onAbort = (): void => {
        void this.stop(session.source, "cancelled").then(resolve, reject);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      session.completion.then((completed) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(completed);
      }, reject);
    });
  }

  /** Wait for PTY output triggered by input to settle before capturing the screen. */
  public async waitForOutputAfter(session: TerminalSession, previousEnd: number): Promise<void> {
    const deadline = Date.now() + 300;
    let lastEnd = previousEnd;
    let changedAt: number | undefined;
    while (Date.now() < deadline) {
      const currentEnd = session.outputStart + session.output.length;
      if (currentEnd !== lastEnd) {
        lastEnd = currentEnd;
        changedAt = Date.now();
        await session.screenReady;
      } else if (changedAt !== undefined && Date.now() - changedAt >= 40) {
        return;
      }
      await delay(10);
    }
    await session.screenReady;
  }
  /** Capture the current virtual terminal viewport as plain text rows. */
  public screenRows(session: TerminalSession): readonly string[] {
    const buffer = session.screen.buffer.active;
    return Array.from({ length: session.rows }, (_, row) =>
      (buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").trimEnd(),
    );
  }

  /** Return the densest changed screen region, marking the cursor when it is inside. */
  public screenChangeRegion(
    session: TerminalSession,
    before: readonly string[],
    count = 6,
  ): { readonly lines: readonly string[]; readonly startRow: number } {
    const after = this.screenRows(session);
    const size = Math.max(1, Math.min(session.rows, count));
    let bestStart = Math.max(0, session.screen.buffer.active.cursorY - Math.floor(size / 2));
    let bestScore = -1;
    for (let start = 0; start <= session.rows - size; start += 1) {
      let score = 0;
      for (let row = start; row < start + size; row += 1) {
        const previous = before[row] ?? "";
        const current = after[row] ?? "";
        const introduced = current.length > 0 && !before.includes(current);
        const removed = previous.length > 0 && current.length === 0;
        if (previous !== current && (introduced || removed)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }
    const cursor = session.screen.buffer.active;
    const lines = after.slice(bestStart, bestStart + size).map((text, index) => {
      const row = bestStart + index;
      if (row !== cursor.cursorY) return text;
      const padded = text.padEnd(cursor.cursorX, " ");
      return `${padded.slice(0, cursor.cursorX)}▌${padded.slice(cursor.cursorX)}`;
    });
    return { lines, startRow: bestStart };
  }

  public screenChangeWindow(
    session: TerminalSession,
    before: readonly string[],
    count = 6,
  ): readonly string[] {
    return this.screenChangeRegion(session, before, count).lines;
  }
  /** Return the latest meaningful rows from the current virtual terminal screen. */
  public screenTail(session: TerminalSession, count = session.rows): readonly string[] {
    const buffer = session.screen.buffer.active;
    const firstRow = Math.max(0, buffer.baseY);
    const lines: string[] = [];
    for (let row = 0; row < session.rows; row += 1) {
      const line = buffer
        .getLine(firstRow + row)
        ?.translateToString(true)
        .trimEnd();
      if (line !== undefined && line.length > 0) lines.push(line);
    }
    return lines.slice(-Math.max(0, count));
  }
  public write(sourceOrId: string, data: string): void {
    const session = this.requiredRunning(sourceOrId);
    session.process?.write(data);
  }

  public sendKeys(sourceOrId: string, keys: string): void {
    const session = this.requiredRunning(sourceOrId);
    session.process?.write(encodeTerminalKeys(keys));
  }

  public async stop(
    sourceOrId: string,
    finalStatus: "stopped" | "cancelled" = "stopped",
  ): Promise<TerminalSession> {
    const session = this.required(sourceOrId);
    if (isTerminalStatus(session.status)) return session;
    session.status = "stopping";
    this.#emitChanged(session);
    await terminateProcessTree(session, false);
    const graceful = await Promise.race([
      session.completion.then(() => true),
      delay(STOP_GRACE_MS).then(() => false),
    ]);
    if (!graceful) {
      await terminateProcessTree(session, true);
      await Promise.race([session.completion, delay(1_000)]);
    }
    if (!isTerminalStatus(session.status)) {
      session.status = finalStatus;
      session.endedAt = Date.now();
      session.resolveCompletion(session);
      this.#emitCompleted(session);
    }
    if (finalStatus === "cancelled") session.status = "cancelled";
    this.#emitChanged(session);
    return session;
  }

  /** Terminate a live process if needed, dispose its screen, and forget the session. */
  public async delete(sourceOrId: string): Promise<void> {
    const session = this.required(sourceOrId);
    session.completionDelivered = true;
    await this.stop(session.source);
    session.screen.dispose();
    this.#sessions.delete(session.id);
    this.#emitChanged(session);
  }
  public async screenLines(sourceOrId: string): Promise<readonly string[]> {
    const session = this.required(sourceOrId);
    await session.screenReady;
    const buffer = session.screen.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buffer.baseY);
    for (let row = start; row < start + session.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines;
  }

  public cursor(sourceOrId: string): { readonly x: number; readonly y: number } {
    const session = this.required(sourceOrId);
    return { x: session.screen.buffer.active.cursorX, y: session.screen.buffer.active.cursorY };
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.all(
      [...this.#sessions.values()]
        .filter((session) => !isTerminalStatus(session.status))
        .map((session) => this.stop(session.source)),
    );
    for (const session of this.#sessions.values()) session.screen.dispose();
    this.#changeListeners.clear();
    this.#completionListeners.clear();
  }

  private required(sourceOrId: string): TerminalSession {
    const session = this.get(sourceOrId);
    if (session === undefined) throw new Error(`Unknown terminal session ${sourceOrId}`);
    return session;
  }

  private requiredRunning(sourceOrId: string): TerminalSession {
    const session = this.required(sourceOrId);
    if (session.status !== "running") {
      throw new Error(
        `Terminal session ${session.source} is ${session.status}; input is unavailable`,
      );
    }
    return session;
  }

  #appendOutput(session: TerminalSession, data: string): void {
    const plain = stripVTControlCharacters(data);
    session.output += plain;
    if (session.output.length > MAX_OUTPUT_CHARS) {
      const removed = session.output.length - MAX_OUTPUT_CHARS;
      session.output = session.output.slice(removed);
      session.outputStart += removed;
    }
    session.screenReady = session.screenReady.then(
      () =>
        new Promise<void>((resolve) => {
          session.screen.write(data, resolve);
        }),
    );
    this.#emitChanged(session);
  }

  #emitChanged(session: TerminalSession): void {
    for (const listener of this.#changeListeners) listener(session);
  }

  #emitCompleted(session: TerminalSession): void {
    for (const listener of this.#completionListeners) listener(session);
  }
}

function createScreen(cols: number, rows: number): XtermTerminal {
  const { Terminal } = require("@xterm/headless") as {
    Terminal: new (options: {
      cols: number;
      rows: number;
      scrollback: number;
      allowProposedApi: boolean;
    }) => XtermTerminal;
  };
  return new Terminal({ cols, rows, scrollback: 2_000, allowProposedApi: true });
}

function defaultSessionId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}
function normalizeSessionId(sourceOrId: string): string {
  return sourceOrId.startsWith("shell:") ? sourceOrId.slice("shell:".length) : sourceOrId;
}

function isTerminalStatus(status: TerminalSession["status"]): boolean {
  return status !== "running" && status !== "stopping";
}

function processEnvironment(): Record<string, string | undefined> {
  return process.env;
}

function cleanEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PAGER: "cat",
    GIT_PAGER: "cat",
    SYSTEMD_PAGER: "cat",
    GH_PAGER: "cat",
  };
}

/** Encode named terminal keys and Unix caret control notation as PTY input. */
export function encodeTerminalKeys(value: string): string {
  return value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map(encodeTerminalKey)
    .join("");
}

function encodeTerminalKey(value: string): string {
  if (/^\^[?@A-Z[\\\]^_]$/iu.test(value)) {
    const character = value.slice(1).toUpperCase();
    return character === "?" ? "\u007f" : String.fromCharCode(character.charCodeAt(0) & 31);
  }

  const parts = value.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts);
  if (
    [...modifiers].some(
      (modifier) => !["ctrl", "control", "alt", "meta", "shift"].includes(modifier),
    )
  ) {
    throw new Error(`Unsupported terminal key ${value}`);
  }
  const ctrl = modifiers.has("ctrl") || modifiers.has("control");
  const alt = modifiers.has("alt") || modifiers.has("meta");
  const shift = modifiers.has("shift");
  if (ctrl && key.length === 1 && /[a-z@[\\\]^_?]/u.test(key)) {
    const character = key.toUpperCase();
    const control =
      character === "?" ? "\u007f" : String.fromCharCode(character.charCodeAt(0) & 31);
    return alt ? `\u001b${control}` : control;
  }

  const simple: Readonly<Record<string, string>> = {
    enter: "\r",
    tab: "\t",
    escape: "\u001b",
    esc: "\u001b",
    backspace: "\u007f",
    home: "\u001b[H",
    end: "\u001b[F",
    delete: "\u001b[3~",
  };
  if (!ctrl && !alt && !shift && simple[key] !== undefined) return simple[key];
  if (alt && !ctrl && !shift && simple[key] !== undefined) return `\u001b${simple[key]}`;

  const finals: Readonly<Record<string, string>> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
    home: "H",
    end: "F",
  };
  const final = finals[key];
  if (final !== undefined) {
    if (!ctrl && !alt && !shift) return `\u001b[${final}`;
    const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    return `\u001b[1;${modifier}${final}`;
  }
  if (alt && !ctrl && key.length === 1) return `\u001b${shift ? key.toUpperCase() : key}`;
  throw new Error(`Unsupported terminal key ${value}`);
}

async function terminateProcessTree(session: TerminalSession, force: boolean): Promise<void> {
  const process = session.process;
  if (process === undefined) return;
  if (globalThis.process.platform !== "win32") {
    try {
      globalThis.process.kill(-process.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      try {
        process.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {}
      return;
    }
  }
  await new Promise<void>((resolve) => {
    const child = spawnProcess(
      "taskkill.exe",
      ["/PID", String(process.pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true, stdio: "ignore" },
    );
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
