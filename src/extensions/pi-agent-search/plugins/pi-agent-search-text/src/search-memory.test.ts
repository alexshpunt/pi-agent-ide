import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { expect, onTestFinished, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";

import { SearchSessionStore, type TextSearchMatch } from "#src/search-session.js";

// A large source like the 27k-line C++ file where repeated searches leaked about 9 MiB each.
const lineCount = 27_000;
const lines = Array.from(
  { length: lineCount },
  (_, index) => `  value_${index} = compute(${index});`,
);
const megabyte = 1024 * 1024;

v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

function liveHeap(): number {
  collectGarbage();
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

function matchesOnLines(source: string, query: string, first: number): TextSearchMatch[] {
  return Array.from({ length: 5 }, (_, offset) => {
    const lineNumber = first + offset * 1000;
    const lineText = lines[lineNumber - 1] ?? "";
    const startColumn = lineText.indexOf(query);
    return {
      source,
      lineNumber,
      startColumn,
      endColumn: startColumn + query.length,
      matchedText: query,
      lineText,
    };
  });
}

async function largeSource(): Promise<{ cwd: string; source: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-memory-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, `${lines.join("\n")}\n`);
  return { cwd, source };
}

test("repeated searches of an unchanged file keep one copy of its content", async () => {
  const { cwd, source } = await largeSource();
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const search = (index: number) =>
    sessions.register(`compute(${index}`, matchesOnLines(source, "compute", index + 1), true, cwd);

  await search(0);
  const afterOneSearch = liveHeap();
  for (let index = 1; index <= 20; index += 1) await search(index);

  expect(liveHeap() - afterOneSearch).toBeLessThan(10 * megabyte);
});

test("searches after each file change do not keep earlier file versions", async () => {
  const { cwd, source } = await largeSource();
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const search = (index: number) =>
    sessions.register(`compute(${index}`, matchesOnLines(source, "compute", index + 1), true, cwd);

  await search(0);
  const afterOneSearch = liveHeap();
  for (let index = 1; index <= 20; index += 1) {
    await appendFile(source, `// change ${index}\n`);
    await search(index);
  }

  expect(liveHeap() - afterOneSearch).toBeLessThan(10 * megabyte);
});
