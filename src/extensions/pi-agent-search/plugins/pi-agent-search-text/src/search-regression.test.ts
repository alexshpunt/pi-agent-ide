import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSearchRecipe, runSearchRecipe } from "#src/search-recipe.js";
import { createTextResolver } from "#src/resolvers.js";
import { SearchSessionStore } from "#src/search-session.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(content: string) {
  const root = path.resolve(".tmp/search-regression");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "input.txt"), content);
  return cwd;
}
test("searches a literal dash filename rather than stdin", async () => {
  const cwd = await fixture("ordinary\n");
  const source = path.join(cwd, "-");
  await writeFile(source, "dash-marker\n");
  const result = await runSearchRecipe(
    createSearchRecipe({ query: "dash-marker", path: source }),
    cwd,
  );
  expect(result.matches).toMatchObject([{ source, matchedText: "dash-marker" }]);
});
test("keeps a directory-relative exclusion when the search path is absolute", async () => {
  const cwd = await fixture("alpha\n");
  await mkdir(path.join(cwd, "sessions"));
  await writeFile(path.join(cwd, "sessions", "ignored.txt"), "beta\n");
  const result = await runSearchRecipe(
    createSearchRecipe({ query: "alpha OR beta", path: cwd, exclude: "sessions/**" }),
    process.cwd(),
  );
  expect(result.matches.map((m) => m.matchedText)).toEqual(["alpha"]);
  const included = await runSearchRecipe(
    createSearchRecipe({ query: "alpha OR beta", path: cwd, include: "sessions/**" }),
    process.cwd(),
  );
  expect(included.matches.map((match) => match.matchedText)).toEqual(["beta"]);
});
test("finds overlapping Boolean alternatives on long lines without a PCRE2 retry failure", async () => {
  const cwd = await fixture("gpt-6-astra " + "x".repeat(12_000_000) + "\n");
  const result = await runSearchRecipe(
    createSearchRecipe({ query: "gpt-6-astra OR astra", path: "input.txt" }),
    cwd,
  );
  expect(result.matches.map((m) => [m.startColumn, m.matchedText])).toEqual([[0, "gpt-6-astra"]]);
});
test("formats a long Unicode line and registers its literal match anchors", async () => {
  const cwd = await fixture("short\n".repeat(10) + "astra " + "aĀ".repeat(6_000_000) + "\n");
  const resolver = createTextResolver(new SearchSessionStore());
  const context = { cwd, signal: new AbortController().signal };
  const result = await resolver.tryResolve(
    { query: "astra", path: "input.txt", limit: 30 },
    context,
  );
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") throw new Error("Expected matches");
  const output = await resolver.format(result.payload, context);
  expect(output.details).toMatchObject({ matchCount: 1, complete: true });
});
