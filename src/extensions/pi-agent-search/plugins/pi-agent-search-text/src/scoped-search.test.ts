import { expect, test } from "vitest";
import { ResultTargetStore, type ResolvedResultTargets } from "pi-agent-resource";
import { runScopedSearch } from "#src/scoped-search.js";
import { SearchSessionStore } from "#src/search-session.js";

const source = "ssh://left/work/note.ts";
const content = 'greet("hello", "world");\r\na😀café end\r\n';
function scope(): ResolvedResultTargets {
  return {
    complete: false,
    targets: [
      {
        source,
        expectedContent: content,
        readCurrent: async () => content,
        ranges: [
          { start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 12 } },
          { start: { lineNumber: 2, column: 3 }, end: { lineNumber: 2, column: 7 } },
        ],
      },
    ],
  };
}

test("scoped text search keeps gaps, remote identities and UTF-16 columns separate", async () => {
  const selected = scope();
  const outside = await runScopedSearch({ query: "world", regex: false }, selected, process.cwd());
  expect(outside).toMatchObject({ matches: [], complete: false });
  const inside = await runScopedSearch(
    { query: "hello|café", regex: true },
    selected,
    process.cwd(),
  );
  expect(inside.complete).toBe(false);
  expect(inside.matches).toMatchObject([
    { source, lineNumber: 1, startColumn: 7, endColumn: 12, matchedText: "hello" },
    { source, lineNumber: 2, startColumn: 3, endColumn: 7, matchedText: "café" },
  ]);
  expect(
    (await runScopedSearch({ query: "hello" }, { targets: [], complete: false }, process.cwd()))
      .matches,
  ).toEqual([]);
  await expect(
    runScopedSearch({ query: "hello", include: "*.ts" }, selected, process.cwd()),
  ).rejects.toThrow("unsupported");
  await expect(
    runScopedSearch(
      { query: "hello", condition: { kind: "term", value: "hello" } },
      selected,
      process.cwd(),
    ),
  ).rejects.toThrow("unsupported");
});

test("search handles preserve a remote owner's guard and the original snapshot", async () => {
  let current = content;
  let blocked = false;
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, async (requested) => {
    expect(requested).toBe(source);
    if (blocked) throw new Error("Owned content is blocked");
    return current;
  });
  const result = await runScopedSearch({ query: "hello" }, scope(), process.cwd());
  const session = await sessions.register("hello", result.matches, result.complete, process.cwd());
  const resolved = targets.resolve(sessions.resultTargets(session.id), process.cwd());
  expect(resolved.complete).toBe(false);
  expect(resolved.targets[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 12 } },
  ]);
  await targets.verify(resolved);
  blocked = true;
  await expect(targets.verify(resolved)).rejects.toThrow("Owned content is blocked");
  blocked = false;
  current = content.replace("hello", "later");
  await expect(targets.verify(resolved)).rejects.toThrow("stale");
});
