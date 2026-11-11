import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TextEditRun } from "pi-agent-text";
import { expect, onTestFinished, test } from "vitest";

import { SearchSessionStore, type TextSearchMatch } from "#src/search-session.ts";

const WORD = "Vec";

/** Every occurrence of WORD, as a search backend reports it. */
async function scan(source: string): Promise<TextSearchMatch[]> {
  const lines = (await readFile(source, "utf8")).split("\n");
  return lines.flatMap((lineText, index) =>
    [...lineText.matchAll(new RegExp(WORD, "gu"))].map((found) => ({
      source,
      lineNumber: index + 1,
      startColumn: found.index,
      endColumn: found.index + WORD.length,
      matchedText: WORD,
      lineText,
    })),
  );
}

async function setup(content: string) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-retry-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, content);
  const store = new SearchSessionStore();
  let searches = 0;
  const session = await store.register(
    WORD,
    await scan(source),
    true,
    cwd,
    undefined,
    { query: WORD, regex: false },
    async () => {
      searches += 1;
      return { matches: await scan(source), complete: true };
    },
  );
  const resolve = async (edit?: TextEditRun) => {
    const attempt = await store
      .resourceResolver()
      .tryResolve(`SEARCH#${session.id}:all:match`, { cwd, ...(edit && { edit }) });
    if (attempt.kind !== "resolved") throw new Error(`Expected targets, got ${attempt.kind}`);
    return attempt.targets;
  };
  return { source, resolve, searches: () => searches };
}

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;
const original = lines("Vec a;", "int b;", "Vec c; Vec d;", "int e;");

/** Selected text and position of each range, read from the content the target expects. */
function selected(targets: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["resolve"]>>) {
  return targets.flatMap((target) => {
    const rows = (target.expectedContent ?? "").split("\n");
    return (target.ranges ?? []).map(
      (range) =>
        `${String(range.start.lineNumber)}:${String(range.start.column)} ${(rows[range.start.lineNumber - 1] ?? "").slice(range.start.column, range.end.column)}`,
    );
  });
}

test("a retry of one edit moves its matches onto the newer text instead of searching again", async () => {
  const { source, resolve, searches } = await setup(original);
  const edit = { attempt: 0 };
  await writeFile(source, `// one\n${original}`);
  await resolve(edit);
  expect(searches()).toBe(1);

  // Another process writes again before this edit could: its retry needs no new search.
  const newer = `// one\n// two\n${original}`;
  await writeFile(source, newer);
  const targets = await resolve(edit);
  expect(searches()).toBe(1);
  expect(targets[0]?.expectedContent).toBe(newer);
  expect(selected(targets)).toEqual(["3:0 Vec", "5:0 Vec", "5:7 Vec"]);
});

test("a retry whose snapshot was current without a search also moves it", async () => {
  const { source, resolve, searches } = await setup(original);
  const edit = { attempt: 0 };
  await resolve(edit);
  await writeFile(source, `// one\n${original}`);
  expect(selected(await resolve(edit))).toEqual(["2:0 Vec", "4:0 Vec", "4:7 Vec"]);
  expect(searches()).toBe(0);
});

test.each([
  ["an added line has the matched text", `${original}Vec f;\n`],
  ["a line with a match changed", lines("Vec a;", "int b;", "Vec c; Vec d; Vec g;", "int e;")],
  ["a block with a match moved", lines("int b;", "Vec c; Vec d;", "int e;", "Vec a;")],
  ["a match was removed", lines("Vec a;", "int b;", "int e;")],
])("a retry searches again when %s", async (_case, changed) => {
  const { source, resolve, searches } = await setup(original);
  const edit = { attempt: 0 };
  await resolve(edit);
  await writeFile(source, changed);
  const targets = await resolve(edit);
  expect(searches()).toBe(1);
  expect(targets[0]?.expectedContent).toBe(changed);
  expect(selected(targets)).toHaveLength((await scan(source)).length);
});

test("a separate edit, and a read, search again after the file changed", async () => {
  const { source, resolve, searches } = await setup(original);
  await resolve({ attempt: 0 });
  await writeFile(source, `// one\n${original}`);
  await resolve({ attempt: 0 });
  expect(searches()).toBe(1);
  await writeFile(source, `// two\n// one\n${original}`);
  await resolve();
  expect(searches()).toBe(2);
});

test("repeated identical lines keep every match when one copy is removed", async () => {
  const repeated = lines("Vec a;", "Vec a;", "Vec a;", "int b;");
  const { source, resolve, searches } = await setup(repeated);
  const edit = { attempt: 0 };
  await resolve(edit);
  // The removed line held a match, so this is not a plain move: a new search decides.
  await writeFile(source, lines("Vec a;", "Vec a;", "int b;"));
  expect(selected(await resolve(edit))).toEqual(["1:0 Vec", "2:0 Vec"]);
  expect(searches()).toBe(1);
});
