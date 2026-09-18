import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  IdeDiagnosticReport,
  IdeDiagnosticReadContext,
  IdeDiagnosticResult,
  IdeDiagnosticSnapshot,
  IdeDiagnosticSource,
} from "#src/api/plugin-protocol.js";
import type { ToolContext } from "#src/toolchain/types.js";

/** Nonempty findings shared by hidden model delivery and a separate UI summary. */
export interface DiagnosticNotification {
  readonly filePath: string;
  readonly results: readonly IdeDiagnosticResult[];
  readonly text: string;
}

interface FileState {
  readonly cwd: string;
  readonly filePath: string;
  readonly content: string;
  readonly controller: AbortController;
  readonly results: Map<string, IdeDiagnosticResult>;
  readonly jobs: Promise<void>[];
  readonly publications: Map<string, number>;
}

/** Session-owned background checks shared by reads and compact agent notifications. */
export class DiagnosticStore {
  private readonly files = new Map<string, FileState>();
  private readonly dirty = new Set<FileState>();
  private readonly sent = new Map<string, string>();
  private readonly queue: (() => Promise<void>)[] = [];
  private running = 0;
  private disposed = false;
  private readonly changeListeners = new Set<(cwd: string, findings: boolean) => void>();

  /** Observe published reports immediately, independently of agent turns. */
  onDidChange(listener: (cwd: string, findings: boolean) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  constructor(
    private readonly sources: readonly IdeDiagnosticSource[],
    private readonly options: {
      readWaitMs?: number;
      checkTimeoutMs?: number;
      concurrency?: number;
    } = {},
  ) {}

  /** Schedule final edit text without waiting for a diagnostic provider. */
  schedule(filePath: string, content: string, { cwd }: ToolContext): void {
    if (!this.disposed) this.ensure(filePath, content, cwd);
  }

  /** Read one current text snapshot; never label unfinished checks as clean. */
  async read(
    filePath: string,
    { cwd, mode, signal }: IdeDiagnosticReadContext,
  ): Promise<IdeDiagnosticSnapshot> {
    signal?.throwIfAborted();
    this.assertActive();
    const absolute = path.resolve(cwd, filePath);
    const content = await readFile(absolute, "utf8");
    this.assertActive();
    const state = this.ensure(absolute, content, cwd);
    if (mode === "complete") await this.waitComplete(state, signal);
    else if (mode !== "snapshot")
      await waitAtMost(Promise.all(state.jobs), this.options.readWaitMs ?? 5000);
    signal?.throwIfAborted();
    this.assertActive();
    const currentText = await readFile(absolute, "utf8");
    this.assertActive();
    const current = this.ensure(absolute, currentText, cwd);
    if (mode === "complete" && current !== state)
      throw Object.assign(new Error("File changed during diagnostics"), {
        code: "DIAGNOSTICS_STALE",
      });
    return { filePath: absolute, content: current.content, results: [...current.results.values()] };
  }

  private async waitComplete(state: FileState, signal?: AbortSignal): Promise<void> {
    const combined = signal
      ? AbortSignal.any([signal, state.controller.signal])
      : state.controller.signal;
    combined.throwIfAborted();
    const cleanupWaiters: (() => void)[] = [];
    await new Promise<void>((resolve, reject) => {
      const fail = (code: string) =>
        reject(Object.assign(new Error(code), { code, details: [...state.results.values()] }));
      const check = () => {
        const results = [...state.results.values()];
        if (results.some((result) => result.status === "unavailable"))
          fail("DIAGNOSTICS_UNAVAILABLE");
        else if (results.every((result) => result.status === "ready")) resolve();
      };
      const abort = () => reject(combined.reason);
      const detach = this.onDidChange(check);
      const timer = setTimeout(
        () => fail("DIAGNOSTICS_TIMEOUT"),
        this.options.checkTimeoutMs ?? 30_000,
      );
      combined.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        detach();
        combined.removeEventListener("abort", abort);
      };
      // Cleanup follows either outcome without changing the original rejection.
      void Promise.resolve().then(check);
      cleanupWaiters.push(cleanup);
    }).finally(() => {
      for (const cleanup of cleanupWaiters) cleanup();
    });
  }
  /** Drain current findings for delivery; pending, unavailable and empty reports stay silent. */
  async takeNotifications(cwd: string): Promise<DiagnosticNotification[]> {
    const notifications: DiagnosticNotification[] = [];
    for (const state of [...this.dirty]) {
      if (state.cwd !== path.resolve(cwd)) continue;
      this.dirty.delete(state);
      if (!(await this.isCurrent(state))) continue;
      const results = [...state.results.values()].filter(
        (result) =>
          result.status !== "pending" &&
          result.status !== "unavailable" &&
          result.diagnostics.length > 0,
      );
      const key = this.key(state.filePath, state.cwd);
      // Fingerprint only findings: empty provider updates must not resend the same report.
      const fingerprint = JSON.stringify(results);
      if (this.sent.get(key) === fingerprint) continue;
      this.sent.set(key, fingerprint);
      // Remember the empty state so a later recurrence can notify again.
      if (results.length === 0) continue;
      const summary = results
        .map((result) => {
          const counts = ["error", "warning", "info", "hint"].flatMap((severity) => {
            const count = result.diagnostics.filter((item) => item.severity === severity).length;
            return count > 0 ? [`${count} ${severity}`] : [];
          });
          return `${result.source} ${counts.join(", ")}${result.status === "snapshot" ? " (snapshot; completion unknown)" : result.status === "unversioned" ? " (unversioned)" : ""}`;
        })
        .join("; ");
      notifications.push({
        filePath: path.relative(cwd, state.filePath),
        results,
        text: `${JSON.stringify(path.relative(cwd, state.filePath))}: ${summary}.`,
      });
    }
    return notifications;
  }

  /** Invalidate all revision-bound callbacks and cancel session-owned work. */
  dispose(): void {
    this.disposed = true;
    this.changeListeners.clear();
    for (const state of this.files.values()) state.controller.abort();
    this.files.clear();
    this.dirty.clear();
    this.sent.clear();
    // Queued jobs drain as cancelled jobs so their waiters can finish.
    this.pump();
  }

  private key(filePath: string, cwd: string): string {
    return JSON.stringify([path.resolve(cwd), path.resolve(cwd, filePath)]);
  }

  private ensure(filePath: string, content: string, cwd: string): FileState {
    const key = this.key(filePath, cwd);
    const previous = this.files.get(key);
    if (previous?.content === content) return previous;
    previous?.controller.abort();
    if (previous) this.dirty.delete(previous);
    const state: FileState = {
      cwd: path.resolve(cwd),
      filePath: path.resolve(cwd, filePath),
      content,
      controller: new AbortController(),
      results: new Map(),
      jobs: [],
      publications: new Map(),
    };
    this.files.set(key, state);

    if (this.sources.length === 0)
      state.results.set("diagnostics", {
        source: "diagnostics",
        status: "unavailable",
        diagnostics: [],
        reason: "No diagnostic sources registered",
      });
    this.dirty.add(state);
    for (const source of this.sources) {
      state.results.set(source.id, { source: source.id, status: "pending", diagnostics: [] });
      const job = new Promise<void>((resolve) => {
        this.queue.push(async () => {
          try {
            await this.check(state, source);
          } finally {
            resolve();
          }
        });
      });
      state.jobs.push(job);
    }
    // Start providers after the edit completion observer has returned.
    queueMicrotask(() => this.pump());
    return state;
  }

  private pump(): void {
    while (this.running < (this.options.concurrency ?? 4) && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private active(state: FileState): boolean {
    return !this.disposed && !state.controller.signal.aborted;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Diagnostics session has ended");
  }

  private async isCurrent(state: FileState): Promise<boolean> {
    if (!this.active(state)) return false;
    const content = await readFile(state.filePath, "utf8").catch(() => undefined);
    return this.active(state) && content === state.content;
  }

  private async publish(
    state: FileState,
    source: string,
    report: IdeDiagnosticReport,
  ): Promise<void> {
    const publication = (state.publications.get(source) ?? 0) + 1;
    state.publications.set(source, publication);
    if (!(await this.isCurrent(state)) || state.publications.get(source) !== publication) return;
    const result: IdeDiagnosticResult = { ...report, source: report.source ?? source };
    if (JSON.stringify(state.results.get(source)) === JSON.stringify(result)) return;
    state.results.set(source, result);
    this.dirty.add(state);
    const findings = [...state.results.values()].some(
      (item) =>
        item.status !== "pending" && item.status !== "unavailable" && item.diagnostics.length > 0,
    );
    if (!findings) this.sent.delete(this.key(state.filePath, state.cwd));
    for (const listener of this.changeListeners) listener(state.cwd, findings);
  }

  private async check(state: FileState, source: IdeDiagnosticSource): Promise<void> {
    if (!(await this.isCurrent(state))) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, state.controller.signal]);

    if (signal.aborted) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(
          () => controller.abort(new Error("Diagnostic check timed out")),
          this.options.checkTimeoutMs ?? 30_000,
        );
      });
      const result = await Promise.race([
        source.diagnose(state.filePath, {
          cwd: state.cwd,
          content: state.content,
          signal,
          publish: (report) => {
            if (!signal.aborted) void this.publish(state, source.id, report);
          },
        }),
        aborted,
      ]);
      await this.publish(state, source.id, result);
    } catch (error) {
      await this.publish(state, source.id, {
        status: "unavailable",
        diagnostics: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

async function waitAtMost(work: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
