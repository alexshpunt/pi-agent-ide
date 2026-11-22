import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ResultTargetStore, type ResultRange } from "./result-targets.ts";

// Timestamps on Linux before 6.13 advance every few milliseconds, and some filesystems store whole
// seconds. A same-size rewrite within one tick keeps size, mtime and ctime. A fine-grained kernel
// cannot produce that on demand, so the store here reads the real file with pinned timestamps.
const original = "one\ntwo\nthree\nfour\n";
const sameSize = original.replace("three", "thr33");
const firstLine: ResultRange = {
  start: { lineNumber: 1, column: 0 },
  end: { lineNumber: 1, column: 3 },
};
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "result-targets-timestamps-"));
  file = path.join(directory, "a.txt");
  writeFileSync(file, original);
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Select line 1, rewrite line 3 with text of the same size, and return the text the selection follows. */
function followedTextAfterSameSizeRewrite(changedNs: bigint): string | undefined {
  const store = new ResultTargetStore({
    stat: (name) => {
      const stat = statSync(name, { bigint: true });
      return name === file ? Object.assign(stat, { mtimeNs: changedNs, ctimeNs: changedNs }) : stat;
    },
  });
  const reference = store.register(
    [{ source: file, expectedContent: original, ranges: [firstLine] }],
    directory,
  );
  writeFileSync(file, sameSize);
  return store.resolve(reference, directory).targets[0]?.expectedContent;
}

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

test("a same-size rewrite in the timestamp tick of the previous change is seen", () => {
  expect(followedTextAfterSameSizeRewrite(nowNs())).toBe(sameSize);
});

test("a same-size rewrite on a filesystem with whole-second timestamps is seen a second later", () => {
  const previousSecond = (nowNs() / 1_000_000_000n - 1n) * 1_000_000_000n;
  expect(followedTextAfterSameSizeRewrite(previousSecond)).toBe(sameSize);
});

test("a file that changed long ago is trusted by its timestamps and not reread", () => {
  const tenSecondsAgo = nowNs() - 10_000_000_123n;
  expect(followedTextAfterSameSizeRewrite(tenSecondsAgo)).toBe(original);
});
