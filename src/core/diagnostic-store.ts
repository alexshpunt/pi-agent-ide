import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  IdeDiagnosticReport,
  IdeDiagnosticResult,
  IdeDiagnosticSnapshot,
  IdeDiagnosticSource,
} from "#src/api/plugin-protocol.js";
import type { ToolContext } from "#src/toolchain/types.js";

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
  async read(filePath: string, { cwd }: ToolContext): Promise<IdeDiagnosticSnapshot> {
    this.assertActive();
    const absolute = path.resolve(cwd, filePath);
    const content = await readFile(absolute, "utf8");
    this.assertActive();
    const state = this.ensure(absolute, content, cwd);
    await waitAtMost(Promise.all(state.jobs), this.options.readWaitMs ?? 5000);
    this.assertActive();
    const currentText = await readFile(absolute, "utf8");
    this.assertActive();
    const current = this.ensure(absolute, currentText, cwd);
    return { filePath: absolute, content: current.content, results: [...current.results.values()] };
  }

  /** Drain changed current counts at a model boundary, not at each provider event. */
  async takeNotifications(cwd: string): Promise<string[]> {
    const lines: string[] = [];
    for (const state of [...this.dirty]) {
      if (state.cwd !== path.resolve(cwd)) continue;
      this.dirty.delete(state);
      if (!(await this.isCurrent(state))) continue;
      const results = [...state.results.values()];
      const summary = results
        .map((result) => {
          if (result.status === "pending" || result.status === "unavailable") {
            return `${result.source} ${result.status}`;
          }
          const counts = ["error", "warning", "info", "hint"].map(
            (severity) =>
              `${result.diagnostics.filter((item) => item.severity === severity).length} ${severity}`,
          );
          return `${result.source} ${counts.join(", ")}${result.status === "snapshot" ? " (snapshot; completion unknown)" : result.status === "unversioned" ? " (unversioned)" : ""}`;
        })
        .join("; ");
      const key = this.key(state.filePath, state.cwd);
      // Fingerprint details too: a different error with the same count is still a change.
      const fingerprint = JSON.stringify(results);
      if (this.sent.get(key) === fingerprint) continue;
      this.sent.set(key, fingerprint);
      lines.push(
        `${JSON.stringify(path.relative(cwd, state.filePath))}: ${summary || "no diagnostic sources"}.`,
      );
    }
    return lines;
  }

  /** Invalidate all revision-bound callbacks and cancel session-owned work. */
  dispose(): void {
    this.disposed = true;
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
    const result: IdeDiagnosticResult = { source, ...report };
    if (JSON.stringify(state.results.get(source)) === JSON.stringify(result)) return;
    state.results.set(source, result);
    this.dirty.add(state);
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
