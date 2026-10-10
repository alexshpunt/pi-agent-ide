import { expect, test } from "vitest";
import type { SearchRequest } from "pi-agent-search/api/search";
import { AgentDocumentationRegistry } from "#src/documentation/registry.js";
import { createDocumentationSearchResolver } from "#src/documentation/search.js";

const context = { cwd: process.cwd() };
function registry() {
  const docs = new AgentDocumentationRegistry();
  docs.register([
    {
      id: "zeta",
      description: "description-only",
      markdown: "# Zeta\nneedle",
      triggers: [{ tool: "read" }],
    },
    {
      id: "alpha",
      description: "description-only",
      markdown: "# Alpha\nNeedle needlework needle\na.b\nПривет мир",
      triggers: [{ tool: "read" }],
    },
  ]);
  return docs;
}
async function search(request: SearchRequest, docs = registry()) {
  const resolver = createDocumentationSearchResolver(docs);
  const result = await resolver.tryResolve(request, context);
  if (result.kind !== "resolved") throw new Error(`Expected resolved search, got ${result.kind}`);
  return {
    result: await resolver.format(result.payload, context),
    data: resolver.toScriptData?.(result.payload, undefined) as {
      complete: boolean;
      matches: {
        source: string;
        matchedText: string;
        range: { startLine: number; startColumn: number };
        references?: unknown;
        target?: string;
      }[];
      target?: string;
      all?: unknown;
    },
  };
}

test("searches guide bodies in ID order and preserves source lines without edit targets", async () => {
  const { data } = await search({ query: "needle", path: "docs:all" });
  expect(
    data.matches.map((m) => [m.source, m.range.startLine, m.range.startColumn, m.matchedText]),
  ).toEqual([
    ["docs:alpha", 2, 0, "Needle"],
    ["docs:alpha", 2, 7, "needle"],
    ["docs:alpha", 2, 18, "needle"],
    ["docs:zeta", 2, 0, "needle"],
  ]);
  expect(data.complete).toBe(true);
  expect(data.target).toBeUndefined();
  expect(data.all).toBeUndefined();
  expect(data.matches.every((m) => m.references === undefined && m.target === undefined)).toBe(
    true,
  );
  expect((await search({ query: "description-only", path: "docs:all" })).data.matches).toEqual([]);
});

test("restricts one guide and applies case and Unicode whole-word flags", async () => {
  const { data } = await search({
    query: "needle",
    path: "docs:alpha",
    caseSensitive: true,
    wholeWord: true,
  });
  expect(data.matches.map((m) => m.range.startColumn)).toEqual([18]);
  expect(
    (await search({ query: "При", path: "docs:alpha", wholeWord: true })).data.matches,
  ).toEqual([]);
  expect(
    (await search({ query: "Привет", path: "docs:alpha", wholeWord: true })).data.matches,
  ).toHaveLength(1);
});

test("keeps ordinary punctuation literal and supports explicit regex and quoted literals", async () => {
  expect((await search({ query: "a.b", path: "docs:all" })).data.matches).toHaveLength(1);
  expect((await search({ query: '"a.b"', path: "docs:all" })).data.matches).toHaveLength(1);
  expect(
    (
      await search({ query: "regex:^Needle", path: "docs:all", caseSensitive: true })
    ).data.matches.map((m) => m.matchedText),
  ).toEqual(["Needle"]);
});

test("uses one limit across guides and distinguishes exact limit from truncation", async () => {
  const limited = await search({ query: "needle", path: "docs:all", limit: 3 });
  expect(limited.data.complete).toBe(false);
  expect(limited.data.matches).toHaveLength(3);
  expect((await search({ query: "needle", path: "docs:all", limit: 4 })).data.complete).toBe(true);
  const empty = await search({ query: "absent", path: "docs:all" });
  expect(empty.data.complete).toBe(true);
  expect(empty.data.matches).toEqual([]);
  expect(limited.result.content.find((part) => part.type === "text")?.text).toContain("incomplete");
});

test("reads the current registry, including guides registered after resolver setup", async () => {
  const docs = new AgentDocumentationRegistry();
  const resolver = createDocumentationSearchResolver(docs);
  expect(await resolver.tryResolve({ query: "late", path: "docs:all" }, context)).toMatchObject({
    kind: "resolved",
  });
  docs.register([
    { id: "late", description: "Late guide", markdown: "late", triggers: [{ tool: "read" }] },
  ]);
  const result = await resolver.tryResolve({ query: "late", path: "docs:all" }, context);
  if (result.kind !== "resolved") throw new Error("Expected the newly registered guide");
  const data = resolver.toScriptData?.(result.payload, undefined) as {
    matches: { source: string }[];
  };
  expect(data.matches[0]?.source).toBe("docs:late");
});

test("requires an explicit all-guides selector for Search", async () => {
  const resolver = createDocumentationSearchResolver(registry());
  const result = await resolver.tryResolve({ query: "needle", path: "docs:" }, context);
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") throw new Error("Expected an explicit selector error");
  expect(String(result.error)).toContain("docs:all");
});
test("leaves unowned scopes alone and rejects invalid owned requests", async () => {
  const resolver = createDocumentationSearchResolver(registry());
  expect(await resolver.tryResolve({ query: "needle", path: "notes.md" }, context)).toEqual({
    kind: "not-handled",
  });
  for (const request of [
    { query: "needle", path: "docs:missing" },
    { query: "needle", path: "docs:all", include: "*.md" },
    { query: "needle", path: "docs:all", exclude: "*.md" },
    { query: "ast:$NAME", path: "docs:all" },
  ])
    expect(await resolver.tryResolve(request, context)).toMatchObject({ kind: "failed" });
  await expect(
    resolver.tryResolve({ query: "regex:[", path: "docs:all" }, context),
  ).rejects.toThrow("Invalid regular expression");
  const controller = new AbortController();
  controller.abort();
  await expect(
    resolver.tryResolve(
      { query: "needle", path: "docs:all" },
      { ...context, signal: controller.signal },
    ),
  ).rejects.toThrow("aborted");
});
