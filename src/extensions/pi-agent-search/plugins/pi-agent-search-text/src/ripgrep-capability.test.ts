import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as ripgrep from "#src/ripgrep.js";
import { createSearchRecipe, runSearchRecipe } from "#src/search-recipe.js";
import { searchText } from "#src/search-backend.js";

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
const result = spawnSync(${JSON.stringify(executable)}, args, {stdio:['ignore','pipe','pipe']});
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
