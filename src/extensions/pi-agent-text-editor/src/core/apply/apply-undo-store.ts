import { createHash, randomBytes } from "node:crypto";
import { captureLocalFileState, restoreLocalFileState } from "#src/core/apply/local-journal.js";
import path from "node:path";
import { isUriSource } from "#src/core/file-operations.js";
import type { ApplyFileAccess, ApplyFileBackup, ApplyFileState } from "#src/api/apply-files.js";

export type ApplyUndoBeforeState = ApplyFileState;

interface ApplyUndoPathState extends ApplyUndoBeforeState {
  readonly ownerKey?: string;
  after: string;
}

interface ApplyUndoReceipt {
  recovery?: boolean;
  readonly access?: Pick<ApplyFileAccess, "capture" | "restore">;
  readonly paths: readonly ApplyUndoPathState[];
}

export interface ApplyUndoResult {
  readonly transaction: string;
  readonly restored: readonly string[];
  /** Publication states from the owning snapshots, not controller filesystem guesses. */
  readonly restoredStates: readonly {
    readonly source: string;
    readonly state: "present" | "absent";
  }[];
}

/** Session-local, single-use receipts with guarded, compensating rollback. */
export class ApplyUndoStore {
  readonly #receipts = new Map<string, ApplyUndoReceipt>();
  #cleanup = Promise.resolve();
  readonly #pendingReleases = new Set<ApplyFileBackup>();
  readonly #restoreState: (state: ApplyUndoBeforeState, signal?: AbortSignal) => Promise<void>;

  readonly #captureState: (source: string, signal?: AbortSignal) => Promise<ApplyUndoBeforeState>;

  /** Use the same resource owner for capture, stale checks, and restore. */
  public constructor(restore = restoreLocalFileState, capture = captureLocalFileState) {
    this.#restoreState = restore;
    this.#captureState = capture;
  }

  async #fingerprint(
    source: string,
    capture = this.#captureState,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const state = await capture(source, signal);
    try {
      return stateFingerprint(state);
    } finally {
      await this.#release([state]);
    }
  }

  async #discard(
    transaction: string,
    additional: readonly ApplyUndoBeforeState[] = [],
  ): Promise<void> {
    const receipt = this.#receipts.get(transaction);
    this.#receipts.delete(transaction);
    await this.#release([...(receipt?.paths ?? []), ...additional]);
  }
  async #release(states: readonly ApplyUndoBeforeState[]): Promise<void> {
    const backups = states.flatMap((state) => (state.backup === undefined ? [] : [state.backup]));
    for (const backup of backups) this.#pendingReleases.add(backup);
    await this.#releaseBackups(backups);
  }
  async #releaseBackups(backups: readonly ApplyFileBackup[]): Promise<void> {
    const results = await Promise.allSettled(
      backups.map(async (backup) => {
        await backup.release();
        this.#pendingReleases.delete(backup);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Apply journal cleanup failed; ownership retained for retry",
      );
  }
  public async record(
    before: readonly ApplyUndoBeforeState[],
    access?: Pick<ApplyFileAccess, "capture" | "restore" | "ownerKey">,
  ): Promise<string> {
    const touched = new Set(before.map((state) => sourceIdentity(state.path)));
    this.invalidate(touched);
    const paths = await Promise.all(
      before.map(async (state) => ({
        ...state,
        after: await this.#fingerprint(state.path, access?.capture),
        ...(access?.ownerKey === undefined ? {} : { ownerKey: access.ownerKey(state.path) }),
      })),
    );
    const transaction = `APPLY#${randomBytes(6).toString("hex").toUpperCase()}`;
    this.#receipts.set(transaction, { paths, ...(access && { access }) });
    return transaction;
  }

  public observeTextChange(
    file: string,
    before: string,
    after: string,
    postProcessing: "deferred" | "complete" | "final",
  ): void {
    const normalized = sourceIdentity(file);
    if (postProcessing === "final") {
      const beforeFingerprint = textFingerprint(before);
      for (const receipt of this.#receipts.values()) {
        const state = receipt.paths.find(
          (candidate) => sourceIdentity(candidate.path) === normalized,
        );
        if (state?.after === beforeFingerprint) state.after = textFingerprint(after);
      }
      return;
    }
    this.invalidate(new Set([normalized]));
  }

  public invalidate(paths: ReadonlySet<string>): void {
    for (const [transaction, receipt] of this.#receipts) {
      if (receipt.paths.some((state) => paths.has(sourceIdentity(state.path)))) {
        // Failed releases remain owned and are retried by disposal.
        const cleanup = this.#discard(transaction).catch(() => {});
        this.#cleanup = Promise.all([this.#cleanup, cleanup]).then(() => undefined);
      }
    }
  }

  /** Release session-scoped backups and wait for invalidation cleanup. */
  public async dispose(): Promise<void> {
    this.invalidate(
      new Set(
        [...this.#receipts.values()].flatMap((receipt) =>
          receipt.paths.map((state) => sourceIdentity(state.path)),
        ),
      ),
    );
    await this.#cleanup;
    await this.#releaseBackups([...this.#pendingReleases]);
  }
  public has(transaction: string): boolean {
    return this.#receipts.has(transaction);
  }

  public async restore(
    transaction: string,
    signal?: AbortSignal,
    ownerKey?: (source: string) => string,
  ): Promise<ApplyUndoResult> {
    signal?.throwIfAborted();
    const receipt = this.#receipts.get(transaction);
    if (receipt === undefined)
      throw coded("APPLY_UNDO_UNAVAILABLE", `No undo receipt is available for ${transaction}.`);

    // Check every configured binding before contacting any retained resource owner.
    if (ownerKey !== undefined) {
      for (const state of receipt.paths) {
        if (state.ownerKey !== undefined && state.ownerKey !== ownerKey(state.path))
          throw Object.assign(
            coded(
              "APPLY_UNDO_OWNER_CHANGED",
              `${state.path} belongs to a different configured owner.`,
            ),
            { effect: "not-applied" },
          );
      }
    }
    for (const state of receipt.paths) {
      const actual = await this.#fingerprint(state.path, receipt.access?.capture, signal);
      if (actual !== state.after && (!receipt.recovery || actual !== stateFingerprint(state))) {
        if (!receipt.recovery) await this.#discard(transaction);
        throw coded(
          "APPLY_UNDO_STALE",
          `${state.path} changed after ${transaction}; refusing to overwrite newer content.`,
        );
      }
    }

    const capture = receipt.access?.capture ?? this.#captureState;
    const restore = receipt.access?.restore ?? this.#restoreState;
    const current: ApplyUndoBeforeState[] = [];
    try {
      for (const state of receipt.paths) {
        signal?.throwIfAborted();
        const snapshot = await capture(state.path, signal);
        current.push(snapshot);
        const actual = stateFingerprint(snapshot);
        if (actual !== state.after && (!receipt.recovery || actual !== stateFingerprint(state)))
          throw coded("APPLY_UNDO_STALE", `${state.path} changed before restoration.`);
      }
    } catch (error) {
      await this.#release(current);
      if (hasCode(error, "APPLY_UNDO_STALE") && !receipt.recovery) await this.#discard(transaction);
      throw error;
    }
    const attempted: number[] = [];
    try {
      for (const [index, state] of receipt.paths.entries()) {
        const baseline = current[index];
        if (baseline === undefined)
          throw coded("INVALID_SNAPSHOT", "Missing current undo snapshot.");
        if (receipt.recovery && stateFingerprint(baseline) === stateFingerprint(state)) continue;
        attempted.push(index);
        try {
          if (signal?.aborted === true)
            throw Object.assign(new Error("Undo canceled before this restoration."), {
              effect: "not-applied",
              name: "AbortError",
            });
          if ((await this.#fingerprint(state.path, capture, signal)) !== stateFingerprint(baseline))
            throw Object.assign(
              coded("APPLY_UNDO_STALE", `${state.path} changed before restoration.`),
              {
                effect: "not-applied",
              },
            );
          await restore(state, signal);
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "effect" in error &&
            error.effect === "not-applied"
          )
            attempted.pop();
          throw error;
        }
      }
    } catch (error) {
      // A failed restore must not be reused with stale assumptions about its effects.
      const rollbackErrors: string[] = [];
      for (const index of attempted.reverse()) {
        const state = current[index];
        if (state === undefined) continue;
        try {
          const observed = await this.#fingerprint(state.path, capture);
          if (observed === stateFingerprint(state)) continue;
          const original = receipt.paths[index];
          if (original === undefined || observed !== stateFingerprint(original))
            throw coded("APPLY_UNDO_STALE", `${state.path} changed before compensation.`);
          await restore(state);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${state.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      const recovery = rollbackErrors.length > 0;
      if (recovery) receipt.recovery = true;
      try {
        if (recovery) await this.#release(current);
        else await this.#discard(transaction, current);
      } catch (cleanupError) {
        rollbackErrors.push(
          `Journal cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw Object.assign(
        coded(
          "APPLY_UNDO_FAILED",
          [
            error instanceof Error ? error.message : String(error),
            ...(recovery
              ? [
                  `Recovery snapshots retained for ${transaction}; another undo attempt checks every path before continuing.`,
                ]
              : []),
          ].join(" "),
        ),
        { rollbackErrors, ...(recovery && { recovery: transaction }) },
      );
    }

    const restored = receipt.paths.map((state) => state.path);
    try {
      await this.#discard(transaction, current);
    } catch (cause) {
      throw Object.assign(
        coded(
          "APPLY_UNDO_CLEANUP_FAILED",
          "Paths restored, but journal cleanup failed; cleanup ownership is retained.",
        ),
        {
          effect: "applied",
          transaction,
          restored,
          cause,
        },
      );
    }
    return {
      transaction,
      restored,
      restoredStates: receipt.paths.map((state) => ({
        source: state.path,
        state: state.existed ? "present" : "absent",
      })),
    };
  }
}

function stateFingerprint(state: ApplyUndoBeforeState): string {
  if (!state.existed) return "absent";
  const digest =
    state.backup?.sha256 ??
    createHash("sha256")
      .update(state.bytes ?? new Uint8Array())
      .digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw coded("INVALID_SNAPSHOT", "Invalid backup fingerprint.");
  return `file:${digest}`;
}
function textFingerprint(content: string): string {
  return `file:${createHash("sha256").update(content).digest("hex")}`;
}

function sourceIdentity(source: string): string {
  return isUriSource(source) ? source : path.normalize(source);
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
