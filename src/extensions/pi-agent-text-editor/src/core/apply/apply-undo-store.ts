import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ApplyUndoBeforeState {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Uint8Array;
}

interface ApplyUndoPathState extends ApplyUndoBeforeState {
  after: string;
}

interface ApplyUndoReceipt {
  readonly paths: readonly ApplyUndoPathState[];
}

export interface ApplyUndoResult {
  readonly transaction: string;
  readonly restored: readonly string[];
}

/** Session-local, single-use receipts for atomic Apply rollback. */
export class ApplyUndoStore {
  readonly #receipts = new Map<string, ApplyUndoReceipt>();
  readonly #restoreState: (state: ApplyUndoBeforeState) => Promise<void>;

  public constructor(restore = restoreState) {
    this.#restoreState = restore;
  }

  public async record(before: readonly ApplyUndoBeforeState[]): Promise<string> {
    const touched = new Set(before.map((state) => path.normalize(state.path)));
    this.invalidate(touched);
    const paths = await Promise.all(
      before.map(async (state) => ({ ...state, after: await fingerprint(state.path) })),
    );
    const transaction = `APPLY#${randomBytes(6).toString("hex").toUpperCase()}`;
    this.#receipts.set(transaction, { paths });
    return transaction;
  }

  public observeTextChange(
    file: string,
    before: string,
    after: string,
    postProcessing: "deferred" | "complete" | "final",
  ): void {
    const normalized = path.normalize(file);
    if (postProcessing === "final") {
      const beforeFingerprint = textFingerprint(before);
      for (const receipt of this.#receipts.values()) {
        const state = receipt.paths.find(
          (candidate) => path.normalize(candidate.path) === normalized,
        );
        if (state?.after === beforeFingerprint) state.after = textFingerprint(after);
      }
      return;
    }
    this.invalidate(new Set([normalized]));
  }

  public invalidate(paths: ReadonlySet<string>): void {
    for (const [transaction, receipt] of this.#receipts) {
      if (receipt.paths.some((state) => paths.has(path.normalize(state.path))))
        this.#receipts.delete(transaction);
    }
  }

  public has(transaction: string): boolean {
    return this.#receipts.has(transaction);
  }

  public async restore(transaction: string): Promise<ApplyUndoResult> {
    const receipt = this.#receipts.get(transaction);
    if (receipt === undefined)
      throw coded("APPLY_UNDO_UNAVAILABLE", `No undo receipt is available for ${transaction}.`);

    for (const state of receipt.paths) {
      if ((await fingerprint(state.path)) !== state.after) {
        this.#receipts.delete(transaction);
        throw coded(
          "APPLY_UNDO_STALE",
          `${state.path} changed after ${transaction}; refusing to overwrite newer content.`,
        );
      }
    }

    const current = await Promise.all(receipt.paths.map((state) => save(state.path)));
    try {
      for (const state of receipt.paths) await this.#restoreState(state);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const state of current) {
        try {
          await this.#restoreState(state);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${state.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      throw Object.assign(
        coded("APPLY_UNDO_FAILED", error instanceof Error ? error.message : String(error)),
        { rollbackErrors },
      );
    }

    this.#receipts.delete(transaction);
    return { transaction, restored: receipt.paths.map((state) => state.path) };
  }
}

async function save(file: string): Promise<ApplyUndoBeforeState> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw coded("INVALID_FILE_TYPE", `${file} is not a regular file.`);
    return { path: file, existed: true, bytes: await readFile(file) };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { path: file, existed: false };
    throw error;
  }
}

function textFingerprint(content: string): string {
  return `file:${createHash("sha256").update(content).digest("hex")}`;
}

async function fingerprint(file: string): Promise<string> {
  const state = await save(file);
  return state.existed
    ? `file:${createHash("sha256")
        .update(state.bytes ?? new Uint8Array())
        .digest("hex")}`
    : "absent";
}

async function restoreState(state: ApplyUndoBeforeState): Promise<void> {
  if (!state.existed) {
    await rm(state.path, { force: true });
    return;
  }
  await mkdir(path.dirname(state.path), { recursive: true });
  await writeFile(state.path, state.bytes ?? new Uint8Array());
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
