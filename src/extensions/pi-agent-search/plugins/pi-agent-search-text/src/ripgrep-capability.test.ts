import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as ripgrep from "#src/ripgrep.ts";
import { captureCurrentMatches } from "#src/current-matches.ts";
import { runScopedSearch } from "#src/scoped-search.ts";
import { createSearchRecipe, runSearchRecipe } from "#src/search-recipe.ts";
import { searchText, searchTextContent } from "#src/search-backend.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(mode: "native" | "no-pcre2" | "match-limit") {
  const root = path.resolve(".tmp/ripgrep-capability");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  directories.push(cwd);
  await writeFile(
    path.join(cwd, "input.txt"),
    "alpha beta\nbeta\nalpha ignored\ngamma delta\ngpt-6-astra\nastra\nα alpha\nALPHA\nalphabet\n",
  );
  const executable = ripgrep.resolveRipgrepExecutable();
  if (mode !== "native") {
    const shim = path.join(cwd, "rg-shim.cjs");
    await writeFile(
      shim,
      `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
const engine = args.indexOf('--engine');
if (${JSON.stringify(mode)} === 'match-limit' && args[engine + 1] === 'auto') {
 process.stderr.write('PCRE2: error matching: match limit exceeded'); process.exit(2);
}
if (engine >= 0) args[engine + 1] = 'default';
const result = spawnSync(${JSON.stringify(executable)}, args, {input: require('node:fs').readFileSync(0), stdio:['pipe','pipe','pipe']});
process.stdout.write(result.stdout ?? '');
const error = (result.stderr ?? '').toString();
process.stderr.write(error.includes('look-around') && ${JSON.stringify(mode)} === 'no-pcre2' ? 'PCRE2 is not available in this build of ripgrep' : error);
process.exit(result.status ?? 2);
`,
    );
    await chmod(shim, 0o755);
    vi.spyOn(ripgrep, "resolveRipgrepExecutable").mockReturnValue(shim);
  }
  return cwd;
}
const scenarios = [
  ["alpha OR beta", [1, 2, 3, 7, 8, 9]],
  ["gpt-6-astra OR astra", [5, 6]],
  ["missing OR absent", []],
  ["alpha AND beta", [1]],
  ["alpha NOT ignored", [1, 7, 8, 9]],
  ["alpha beta OR gamma", [1, 4]],
  ["(alpha OR gamma) AND (beta OR delta) NOT ignored", [1, 4]],
  ['"alpha beta"', [1]],
] as const;
test.each(["native", "no-pcre2"] as const)(
  "keeps Boolean line semantics with %s ripgrep",
  async (mode) => {
    const cwd = await fixture(mode);
    for (const [query, lines] of scenarios) {
      const result = await runSearchRecipe(createSearchRecipe({ query, path: "input.txt" }), cwd);
      expect(
        result.matches.map((m) => m.lineNumber),
        query,
      ).toEqual(lines);
      expect(result.complete).toBe(true);
      expect(result.notices).toEqual([]);
    }
    const ranges = await runSearchRecipe(
      createSearchRecipe({
        query: "alpha OR beta",
        path: "input.txt",
        wholeWord: true,
        caseSensitive: true,
      }),
      cwd,
    );
    expect(
      ranges.matches.map((m) => [m.lineNumber, m.startColumn, m.endColumn, m.matchedText]),
    ).toEqual([
      [1, 0, 5, "alpha"],
      [2, 0, 4, "beta"],
      [3, 0, 5, "alpha"],
      [7, 2, 7, "alpha"],
    ]);
  },
);
test("reports a missing PCRE2 engine for an explicit regex and allows the next literal search", async () => {
  const cwd = await fixture("no-pcre2");
  await expect(
    searchText({ query: "(?=alpha)alpha", regex: true, path: "input.txt" }, cwd),
  ).rejects.toThrow("Install ripgrep with PCRE2 support");
  expect(ripgrep.resolveRipgrepExecutable).toHaveBeenCalledTimes(1);
  expect((await searchText({ query: "alpha", path: "input.txt" }, cwd)).matches.length).toBe(5);
});
test("bounds a match-limit retry and preserves the original failure instead of hiding it", async () => {
  const cwd = await fixture("match-limit");
  await expect(
    searchText({ query: "(?=alpha)alpha", regex: true, path: "input.txt" }, cwd),
  ).rejects.toThrow("PCRE2 match limit");
  expect(ripgrep.resolveRipgrepExecutable).toHaveBeenCalledTimes(2);
});

const heldText = "alpha beta\ngamma\nbeta alpha\n";
test("a scoped search retries a regex that exceeds the PCRE2 match limit with the default engine", async () => {
  const cwd = await fixture("match-limit");
  const source = path.join(cwd, "held.txt");
  const result = await runScopedSearch(
    { query: "al(pha)", regex: true },
    {
      complete: true,
      targets: [
        {
          source,
          expectedContent: heldText,
          readCurrent: async () => heldText,
          ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 4, column: 0 } }],
        },
      ],
    },
    cwd,
  );
  expect(result.matches.map((match) => [match.lineNumber, match.startColumn])).toEqual([
    [1, 0],
    [3, 5],
  ]);
  expect(ripgrep.resolveRipgrepExecutable).toHaveBeenCalledTimes(2);
});
test("the anchor capture matches a file another session wrote after a match-limit regex", async () => {
  const cwd = await fixture("match-limit");
  const source = path.join(cwd, "held.txt");
  // The backend matched the file before another session inserted a line at its top.
  const written = `new first line\n${heldText}`;
  const captured = await captureCurrentMatches(
    {
      complete: true,
      matches: [
        {
          source,
          lineNumber: 1,
          startColumn: 0,
          endColumn: 5,
          matchedText: "alpha",
          lineText: "alpha beta",
        },
      ],
    },
    cwd,
    {
      request: { query: "al(pha)", regex: true },
      inContent: true,
      read: async () => written,
    },
  );
  expect(captured.matches.map((match) => [match.lineNumber, match.startColumn])).toEqual([
    [2, 0],
    [4, 5],
  ]);
  expect(ripgrep.resolveRipgrepExecutable).toHaveBeenCalledTimes(2);
});
test("a text search reports the match-limit failure of both engines instead of hiding it", async () => {
  const cwd = await fixture("match-limit");
  const error = await searchTextContent(
    { query: "(?=alpha)alpha", regex: true },
    heldText,
    cwd,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).message).toContain("PCRE2 match limit");
  expect(((error as AggregateError).errors[0] as Error).message).toContain("match limit exceeded");
  expect(ripgrep.resolveRipgrepExecutable).toHaveBeenCalledTimes(2);
});
