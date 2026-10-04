import { describe, expect, it } from "vitest";
import { createWebResolver } from "#src/resolver.js";
import { createWebSearchResolver } from "#src/search.js";

const context = { cwd: process.cwd() };
function resolver(text: string) {
  return createWebSearchResolver(
    createWebResolver(
      {
        convert: async () => [{ type: "text", text }],
      },
      {
        fetch: async () =>
          new Response("<html>raw html</html>", { headers: { "content-type": "text/html" } }),
        autoBrowserFallback: false,
      },
    ),
  );
}

describe("web search", () => {
  it("offers mixed candidate groups after zero hits without refetching converted URL content", async () => {
    const text = [
      "const hintStrings = this.hintStrings(2);",
      "if (hintStrings.length) marker.hintString = hintStrings[0];",
      "hintStrings(linkCount) {}",
      "generateHintString(number) {}",
      "this.generateHintString(2);",
    ].join("\n");
    let conversions = 0;
    let fetches = 0;
    const search = createWebSearchResolver(
      createWebResolver(
        {
          convert: async () => {
            conversions++;
            return [{ type: "text", text }];
          },
        },
        {
          fetch: async () => {
            fetches++;
            return new Response("raw", { headers: { "content-type": "text/html" } });
          },
          autoBrowserFallback: false,
        },
      ),
    );
    const result = await search.tryResolve(
      { query: "generateHintStrings", path: "https://example.test/hints.js" },
      context,
    );
    if (result.kind !== "resolved") throw new Error("Expected URL search result");
    const data = search.toScriptData?.(result.payload, undefined) as {
      matches: unknown[];
      fuzzy?: {
        candidates: { identifier: string; matchCount: number; selection: { all?: unknown } }[];
      };
    };
    expect(data.matches).toEqual([]);
    expect(data.fuzzy?.candidates).toEqual([
      expect.objectContaining({ identifier: "hintStrings", matchCount: 5 }),
      expect.objectContaining({ identifier: "generateHintString", matchCount: 2 }),
    ]);
    expect(data.fuzzy?.candidates.every((candidate) => candidate.selection.all === undefined)).toBe(
      true,
    );
    const formatted = await search.format(result.payload, context);
    const block = formatted.content[0];
    if (block?.type !== "text") throw new Error("Expected candidate text");
    expect(block.text).toContain("No matches in https://example.test/hints.js");
    expect(block.text).toContain("hintStrings");
    expect(block.text).toContain("generateHintString");
    expect(fetches).toBe(1);
    expect(conversions).toBe(1);
  });
  it("searches converted content and keeps the requested URL", async () => {
    const search = resolver("Extensions\nmore extensions");
    const result = await search.tryResolve(
      { query: "extensions", path: "https://example.test" },
      context,
    );
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("Expected a result");
    const data = search.toScriptData?.(result.payload, undefined) as {
      matches: { source: string }[];
      complete: boolean;
    };
    expect(data.matches).toHaveLength(2);
    expect(data.matches[0]?.source).toBe("https://example.test");
    expect(data.complete).toBe(true);
    const formatted = await search.format(result.payload, context);
    expect(formatted.content[0]?.type === "text" && formatted.content[0].text).toContain(
      "Extensions",
    );
    expect(formatted.content[0]?.type === "text" && formatted.content[0].text).not.toContain(
      "raw html",
    );
  });

  it("reports truncation only when another match exists", async () => {
    const search = resolver("word word words");
    const result = await search.tryResolve(
      { query: "word", wholeWord: true, limit: 1, path: "http://example.test/" },
      context,
    );
    if (result.kind !== "resolved") throw new Error("Expected a result");
    expect(search.toScriptData?.(result.payload, undefined)).toMatchObject({
      complete: false,
      matches: [expect.objectContaining({ matchedText: "word" })],
    });
    const exact = await search.tryResolve(
      { query: "regex:words$", limit: 1, path: "http://example.test/" },
      context,
    );
    if (exact.kind !== "resolved") throw new Error("Expected a result");
    expect(search.toScriptData?.(exact.payload, undefined)).toMatchObject({ complete: true });
  });

  it("keeps case-sensitive searches and empty results distinct", async () => {
    const search = resolver("Extensions");
    const result = await search.tryResolve(
      { query: "extensions", caseSensitive: true, path: "https://example.test/" },
      context,
    );
    if (result.kind !== "resolved") throw new Error("Expected a result");
    expect(search.toScriptData?.(result.payload, undefined)).toMatchObject({
      matches: [],
      complete: true,
    });
  });

  it("fails invalid URLs and regexes instead of falling through to local search", async () => {
    const search = resolver("text");
    expect(await search.tryResolve({ query: "text", path: "https://" }, context)).toMatchObject({
      kind: "failed",
    });
    await expect(
      search.tryResolve({ query: "regex:[", path: "https://example.test/" }, context),
    ).rejects.toThrow(/Invalid regular expression/u);
  });

  it("keeps long page lines out of the rendered output", async () => {
    const search = resolver(`${"a".repeat(20_000)} extensions ${"b".repeat(20_000)}`);
    const result = await search.tryResolve(
      { query: "extensions", path: "https://example.test/" },
      context,
    );
    if (result.kind !== "resolved") throw new Error("Expected a result");
    const formatted = await search.format(result.payload, context);
    const block = formatted.content[0];
    if (block?.type !== "text") throw new Error("Expected text");
    expect(block.text).toContain("extensions");
    expect(block.text.length).toBeLessThan(1000);
  });
  it("bounds rendered output even with a large match limit", async () => {
    const search = resolver(`${"extensions " + "x".repeat(300)}\n`.repeat(1000));
    const result = await search.tryResolve(
      { query: "extensions", path: "https://example.test/", limit: 1000 },
      context,
    );
    if (result.kind !== "resolved") throw new Error("Expected a result");
    const formatted = await search.format(result.payload, context);
    const block = formatted.content[0];
    if (block?.type !== "text") throw new Error("Expected text");
    expect(Buffer.byteLength(block.text)).toBeLessThan(50 * 1024);
    expect(block.text).toContain("Output shortened");
  });
  it("does not claim local paths", async () => {
    expect(
      await resolver("text").tryResolve({ query: "text", path: "README.md" }, context),
    ).toEqual({ kind: "not-handled" });
  });
});
