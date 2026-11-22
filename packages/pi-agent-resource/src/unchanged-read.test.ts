import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readUnchanged, type FileGenerationReader } from "./unchanged-read.ts";

// Timestamps on Linux before 6.13 advance every few milliseconds, and some filesystems store whole
// seconds. A same-size rewrite within one tick keeps size, mtime and ctime. A fine-grained kernel
// cannot produce that on demand, so these tests read the real file with pinned timestamps.
const original = "one\ntwo\n";
const sameSize = "one\ntw0\n";
let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "unchanged-read-"));
  file = path.join(directory, "a.txt");
  await writeFile(file, original);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/** Metadata of the real file whose modification and change times are `changedNs`. */
function pinned(changedNs: bigint): FileGenerationReader {
  return async (name) => {
    const { dev, ino, mode, size } = await stat(name, { bigint: true });
    return { dev, ino, mode, size, mtimeNs: changedNs, ctimeNs: changedNs };
  };
}

/** Reads the file while another writer replaces it with text of the same size. */
async function readDuringSameSizeRewrite(changedNs: bigint) {
  let reads = 0;
  const result = await readUnchanged(
    file,
    async () => {
      reads += 1;
      const text = await readFile(file, "utf8");
      if (reads === 1) await writeFile(file, sameSize);
      return text;
    },
    (first, second) => first === second,
    pinned(changedNs),
  );
  return { result, reads };
}

test("a same-size rewrite in the timestamp tick of the previous change is reported as a change", async () => {
  expect((await readDuringSameSizeRewrite(nowNs())).result).toBeUndefined();
});

test("a same-size rewrite on a filesystem with whole-second timestamps is reported a second later", async () => {
  const previousSecond = (nowNs() / 1_000_000_000n - 1n) * 1_000_000_000n;
  expect((await readDuringSameSizeRewrite(previousSecond)).result).toBeUndefined();
});

test("a file that changed long ago is trusted by its timestamps and read once", async () => {
  const { result, reads } = await readDuringSameSizeRewrite(nowNs() - 10_000_000_123n);
  expect(result?.value).toBe(original);
  expect(reads).toBe(1);
});

test("a file that changed just now and stayed the same is returned after a second read", async () => {
  let reads = 0;
  const result = await readUnchanged(
    file,
    async () => {
      reads += 1;
      return original;
    },
    (first, second) => first === second,
    pinned(nowNs()),
  );
  expect(result?.value).toBe(original);
  expect(reads).toBe(2);
});

test("a rewrite that changes the file's stamp is reported without a second read", async () => {
  let reads = 0;
  const result = await readUnchanged(
    file,
    async () => {
      reads += 1;
      await writeFile(file, `${original}more\n`);
      return original;
    },
    (first, second) => first === second,
  );
  expect(result).toBeUndefined();
  expect(reads).toBe(1);
});
