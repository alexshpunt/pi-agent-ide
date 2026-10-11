import { expect, test } from "vitest";
import { ResultTargetStore, type ResolvedResultTargets } from "pi-agent-resource";
import { runScopedSearch } from "#src/scoped-search.js";
import { createSearchRecipe } from "#src/search-recipe.js";
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
  const quoted = await runScopedSearch(
    createSearchRecipe({ query: '"hello"' }),
    selected,
    process.cwd(),
  );
  expect(quoted.matches).toMatchObject([{ source, lineNumber: 1, matchedText: "hello" }]);
});

test("Boolean scoped search cannot use excluded terms or join sparse gaps", async () => {
  const selected = scope();
  const target = selected.targets[0];
  if (!target) throw new Error("Missing fixture target");
  const run = (query: string) =>
    runScopedSearch(createSearchRecipe({ query }), selected, process.cwd());
  expect((await run("hello AND world")).matches).toEqual([]);
  expect((await run("hello AND café")).matches).toEqual([]);
  expect((await run("hello NOT world")).matches).toMatchObject([
    { lineNumber: 1, matchedText: "hello" },
  ]);
  const either = await run("hello OR café");
  expect(either.complete).toBe(false);
  expect(either.matches).toMatchObject([
    { lineNumber: 1, startColumn: 7, matchedText: "hello" },
    { lineNumber: 2, startColumn: 3, matchedText: "café" },
  ]);
  const sparse = {
    ...selected,
    targets: [
      {
        ...target,
        ranges: [
          { start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 12 } },
          { start: { lineNumber: 1, column: 16 }, end: { lineNumber: 1, column: 21 } },
        ],
      },
    ],
  };
  expect(
    (await runScopedSearch(createSearchRecipe({ query: "hello AND world" }), sparse, process.cwd()))
      .matches,
  ).toEqual([]);
  const whole = {
    ...selected,
    targets: [
      {
        ...target,
        ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 24 } }],
      },
    ],
  };
  expect(
    (await runScopedSearch(createSearchRecipe({ query: "hello AND world" }), whole, process.cwd()))
      .matches,
  ).toMatchObject([{ lineNumber: 1, matchedText: "hello" }]);
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
  const resolved = targets.resolve(session.target, process.cwd());
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
