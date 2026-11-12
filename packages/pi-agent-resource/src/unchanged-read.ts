import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * How long after a file's last change its stamp cannot prove that the file stayed the same. A
 * filesystem timestamp advances in ticks: a few milliseconds on Linux before 6.13, one or two
 * seconds on filesystems that store whole seconds. A rewrite of the same size within one tick keeps
 * the stamp, so the text of such a file is compared too.
 */
const racyWindowNs = 100_000_000n;
const racyWholeSecondWindowNs = 2_000_000_000n;

/** Whether a file last changed so recently that a same-size rewrite would keep its timestamps. */
export function isRacyTimestamp(changedNs: bigint, nowMs: number = Date.now()): boolean {
  const window = changedNs % 1_000_000_000n === 0n ? racyWholeSecondWindowNs : racyWindowNs;
  // A timestamp ahead of this clock, such as one from a network share, is racy too.
  return BigInt(nowMs) * 1_000_000n - changedNs < window;
}

/** The fields of a file's metadata that identify one generation of it. */
export type FileGeneration = Pick<
  BigIntStats,
  "dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs"
>;

/** Reads a file's metadata, throwing when the file is missing. */
export type FileGenerationReader = (file: string) => Promise<FileGeneration>;

const localGeneration: FileGenerationReader = (file) => stat(file, { bigint: true });

/** The text of one read that no write overlapped, with the file's stamp at that time. */
export interface UnchangedRead<T> {
  readonly value: T;
  readonly stamp: string;
}

/**
 * Runs `read` and returns its value, or `undefined` when the file changed while it was read.
 * The file's stamp is compared before and after. A stamp cannot see a same-size write within one
 * timestamp tick, so a file that changed that recently is read a second time, and the two values
 * must be `same`.
 */
export async function readUnchanged<T>(
  file: string,
  read: () => Promise<T>,
  same: (first: T, second: T) => boolean,
  readGeneration: FileGenerationReader = localGeneration,
): Promise<UnchangedRead<T> | undefined> {
  const before = await readGeneration(file);
  const value = await read();
  const after = await readGeneration(file);
  const stamp = generationStamp(before);
  if (stamp !== generationStamp(after)) return undefined;
  const changedNs = after.mtimeNs > after.ctimeNs ? after.mtimeNs : after.ctimeNs;
  if (isRacyTimestamp(changedNs) && !same(value, await read())) return undefined;
  return { value, stamp };
}

function generationStamp(generation: FileGeneration): string {
  const { dev, ino, mode, size, mtimeNs, ctimeNs } = generation;
  return `${dev}:${ino}:${mode}:${size}:${mtimeNs}:${ctimeNs}`;
}
