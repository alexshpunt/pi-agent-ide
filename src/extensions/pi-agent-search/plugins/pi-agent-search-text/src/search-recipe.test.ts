import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createSearchRecipe, runSearchRecipe } from "#src/search-recipe.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(content: string): Promise<string> {
  const root = path.resolve(".agents/tmp/search-recipe-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "case-"));
  directories.push(dir);
  await writeFile(path.join(dir, "input.txt"), content);
  return dir;
}
async function search(query: string, content: string) {
  const cwd = await fixture(content);
  return runSearchRecipe(createSearchRecipe({ query, path: "input.txt" }), cwd);
}

describe("hybrid search through ripgrep", () => {
  test("accepts the screenshot's Boolean query containing a function call and protocol text", async () => {
    const result = await search(
      'lsp:<symbol> OR startsWith("lsp:") OR "lsp:"',
      'if (query.startsWith("lsp:")) {}\nUse lsp:<symbol>\n',
    );
    expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
    expect(result.notices).toEqual([]);
  });
  test("keeps literal hits ahead of broader regex matches", async () => {
    const result = await search("foo.bar", "foo.bar\nfooXbar\n");
    expect(result.matches.map((match) => match.matchedText)).toEqual(["foo.bar"]);
    expect(result.notices).toEqual([]);
  });
  test("tries regex only after literal search finds nothing", async () => {
    const result = await search("foo.bar", "fooXbar\n");
    expect(result.matches.map((match) => match.matchedText)).toEqual(["fooXbar"]);
    expect(result.notices.join(" ")).toContain("unquoted terms as regex");
  });
  test.each(['"foo.bar"', "'foo.bar'"])("keeps %s literal", async (query) => {
    const result = await search(query, "fooXbar\n");
    expect(result.matches).toEqual([]);
    expect(result.notices).toEqual([]);
  });
  test.each(["call(", "[broken", "(?<broken", "*flag"])(
    "skips invalid optional regex %s",
    async (query) => {
      const exact = await search(query, `${query}\n`);
      expect(exact.matches[0]?.matchedText).toBe(query);
      const absent = await search(query, "nothing here\n");
      expect(absent.matches).toEqual([]);
      expect(absent.notices.join(" ")).toContain("invalid regex skipped");
    },
  );
  test("preserves regex blocks, escapes, and quoted terms in Boolean fallback", async () => {
    const result = await search(
      String.raw`(?:foo|bar)\d+ AND "keep.me" NOT ignored`,
      "foo42 keep.me\nbar7 keep.me\nfoo42 keepXme\nbar7 keep.me ignored\n",
    );
    expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
    expect(result.matches.map((match) => match.matchedText)).toEqual(["foo42", "bar7"]);
  });
  test("keeps spaces and operator characters inside regex classes", async () => {
    const result = await search(String.raw`[()| ]+tag AND keep`, "()| tag keep\nother keep\n");
    expect(result.matches.map((match) => match.matchedText)).toEqual(["()| tag"]);
  });
  test("keeps regex groups with spaces intact", async () => {
    const result = await search("(?:foo bar|baz)+ AND keep", "foo bar keep\nbaz keep\nfoo keep\n");
    expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
  });
  test("treats an unspaced pipe as regex syntax after the whole literal", async () => {
    expect(
      (await search("foo|bar", "foo|bar\nfoo\nbar\n")).matches.map((m) => m.matchedText),
    ).toEqual(["foo|bar"]);
    expect((await search("foo|bar", "foo\nbar\n")).matches.map((m) => m.matchedText)).toEqual([
      "foo",
      "bar",
    ]);
  });
  test("keeps the existing final word fallback", async () => {
    const result = await search("missing package", "package alone\n");
    expect(result.matches[0]?.matchedText).toBe("package");
    expect(result.notices.join(" ")).toContain("separate words");
  });
  test("does not broaden Boolean or quoted multi-word conditions into words", async () => {
    expect((await search("missing AND package", "package alone\n")).matches).toEqual([]);
    expect((await search('"missing package"', "package alone\n")).matches).toEqual([]);
  });
  test("preserves filters and marks incomplete fallback results", async () => {
    const cwd = await fixture("Foo1\nfoo2\nfoo3\n");
    await writeFile(path.join(cwd, "ignored.txt"), "foo9\n");
    const result = await runSearchRecipe(
      createSearchRecipe({
        query: "foo[0-9]",
        include: "*.txt",
        exclude: "ignored.txt",
        caseSensitive: true,
        wholeWord: true,
        limit: 1,
      }),
      cwd,
    );
    expect(result.matches.map((m) => m.matchedText)).toEqual(["foo2"]);
    expect(result.complete).toBe(false);
  });
  test("propagates I/O errors, cancellation, and explicit regex syntax errors", async () => {
    const cwd = await fixture("nothing\n");
    await expect(
      runSearchRecipe(createSearchRecipe({ query: "foo.bar", path: "missing" }), cwd),
    ).rejects.toThrow(/No such file/iu);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSearchRecipe(createSearchRecipe({ query: "foo.bar" }), cwd, controller.signal),
    ).rejects.toThrow(/abort/iu);
    await expect(runSearchRecipe({ query: "call(", regex: true }, cwd)).rejects.toThrow(
      /regex|PCRE2/iu,
    );
  });
});
