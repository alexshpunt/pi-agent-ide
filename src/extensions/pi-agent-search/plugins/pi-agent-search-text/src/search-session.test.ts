import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, onTestFinished } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";

import {
  allocateSearchSessionId,
  createSearchSessionId,
  SearchSessionStore,
  type TextSearchMatch,
} from "#src/search-session.js";

function searchMatch(source: string, matchedText: string): TextSearchMatch {
  return {
    source,
    lineNumber: 1,
    startColumn: 0,
    endColumn: matchedText.length,
    matchedText,
    lineText: matchedText,
  };
}

test("numbered line aliases keep complete containing lines and expire after source changes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-line-alias-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.txt");
  const original = "prefix OLD\r\nTAIL\r\n";
  await writeFile(source, original);
  const targets = new ResultTargetStore();
  const session = await new SearchSessionStore(undefined, targets).register(
    "OLD\\r\\nTAIL",
    [
      {
        source,
        lineNumber: 1,
        endLineNumber: 2,
        startColumn: 7,
        endColumn: 4,
        matchedText: "OLD\r\nTAIL",
        lineText: "prefix OLD",
      },
    ],
    false,
    cwd,
  );
  const reference = `SEARCH#${session.id}:1:line`;
  const selected = targets.resolve(reference, cwd);
  expect(selected.complete).toBe(true);
  expect(selected.targets[0]).toMatchObject({
    source,
    expectedContent: original,
    ranges: [
      {
        start: { lineNumber: 1, column: 0 },
        end: { lineNumber: 3, column: 0 },
        linewise: true,
      },
    ],
  });
  await targets.verify(selected);
  await writeFile(source, "changed\r\n");
  await expect(targets.verify(selected)).rejects.toThrow(/stale/u);
  await writeFile(source, original);
  expect(() => targets.resolve(reference, cwd)).toThrow(/expired/u);
});
test("keeps changed search results displayable without registering anchors", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-changing-snapshot-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "output.log");
  await writeFile(source, "new output\n", "utf8");

  const session = await new SearchSessionStore().registerIfCurrent(
    "old",
    [searchMatch(source, "old output")],
    true,
    cwd,
  );

  expect(session).toBeUndefined();
});

test("Search input scopes preserve numbered snapshots, refresh all, and accept empty refreshed scopes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-input-scope-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.txt");
  await writeFile(source, "old\n");
  const store = new SearchSessionStore();
  let refreshes = 0;
  const session = await store.register(
    "original",
    [searchMatch(source, "old")],
    true,
    cwd,
    undefined,
    { query: "original", regex: false },
    async () => {
      refreshes++;
      return { matches: refreshes === 1 ? [searchMatch(source, "new")] : [], complete: true };
    },
  );
  const first = await store.resolveSearchScope(`SEARCH#${session.id}:1:match`, { cwd });
  expect(first?.targets[0]).toMatchObject({
    source,
    expectedContent: "old\n",
    ranges: [
      {
        start: { lineNumber: 1, column: 0 },
        end: { lineNumber: 1, column: 3 },
      },
    ],
  });
  await writeFile(source, "new\n");
  await expect(store.resolveSearchScope(`SEARCH#${session.id}:1:line`, { cwd })).rejects.toThrow(
    /stale/u,
  );
  const refreshed = await store.resolveSearchScope(`SEARCH#${session.id}:all:line`, { cwd });
  expect(refreshed).toMatchObject({
    complete: true,
    targets: [
      {
        source,
        expectedContent: "new\n",
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: { lineNumber: 2, column: 0 },
            linewise: true,
          },
        ],
      },
    ],
  });
  expect(await refreshed?.targets[0]?.readCurrent?.()).toBe("new\n");
  expect(refreshes).toBe(1);
  await writeFile(source, "gone\n");
  await expect(
    store.resolveSearchScope(`SEARCH#${session.id}:all:match`, { cwd }),
  ).resolves.toEqual({ complete: true, targets: [] });
  expect(refreshes).toBe(2);
});

test("Search input scopes reject unknown, cross-worktree and incomplete all references", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-input-guards-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.txt");
  await writeFile(source, "old\n");
  const store = new SearchSessionStore();
  const partial = await store.register("old", [searchMatch(source, "old")], false, cwd);
  await expect(store.resolveSearchScope(`SEARCH#${partial.id}:all:line`, { cwd })).rejects.toThrow(
    /limited/u,
  );
  await expect(
    store.resolveSearchScope(`SEARCH#${partial.id}:1:line`, { cwd: path.join(cwd, "other") }),
  ).rejects.toThrow(/stale/u);
  await expect(store.resolveSearchScope("SEARCH#FFFF:1:line", { cwd })).rejects.toThrow(/stale/u);
  await expect(store.resolveSearchScope("SEARCH#not-issued", { cwd })).rejects.toThrow(
    /Invalid Search reference/u,
  );
  await expect(store.resolveSearchScope("note.txt", { cwd })).resolves.toBeUndefined();
  await expect(
    store.resolveSearchScope(`SEARCH#${partial.id}:1:line`, { cwd }),
  ).resolves.toMatchObject({ targets: [{ source }] });
});
test("search session ids start at four characters and grow on collision", () => {
  const firstIdentity = `ABCD0${"0".repeat(59)}`;
  const secondIdentity = `ABCD1${"0".repeat(59)}`;

  expect(allocateSearchSessionId(firstIdentity, new Set())).toBe("ABCD");
  expect(allocateSearchSessionId(secondIdentity, new Set(["ABCD"]))).toBe("ABCD1");
});

test("colliding short ids keep both registered searches resolvable", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-collision-"));
  const firstSource = path.join(cwd, "first.txt");
  const secondSource = path.join(cwd, "second.txt");
  await writeFile(firstSource, "first\n", "utf8");
  await writeFile(secondSource, "second\n", "utf8");
  const identities = [`ABCD0${"0".repeat(59)}`, `ABCD1${"0".repeat(59)}`];
  let identityIndex = 0;
  const store = new SearchSessionStore(() => {
    const identity = identities[identityIndex];
    identityIndex += 1;
    if (identity === undefined) throw new Error("Missing test identity.");
    return identity;
  });

  const first = await store.register("first", [searchMatch(firstSource, "first")], true, cwd);
  const second = await store.register("second", [searchMatch(secondSource, "second")], true, cwd);

  expect(first.id).toBe("ABCD");
  expect(second.id).toBe("ABCD1");
  await expect(
    store.resourceResolver().tryResolve("SEARCH#ABCD:1:match", { cwd }),
  ).resolves.toMatchObject({ kind: "resolved", targets: [{ source: firstSource }] });
  await expect(
    store.resourceResolver().tryResolve("SEARCH#ABCD1:1:match", { cwd }),
  ).resolves.toMatchObject({ kind: "resolved", targets: [{ source: secondSource }] });
});

test("search session id allocation fails instead of reusing an occupied identity", () => {
  const identity = "A".repeat(64);
  const occupiedPrefixes = new Set(
    Array.from({ length: 61 }, (_, index) => identity.slice(0, index + 4)),
  );

  expect(() => allocateSearchSessionId(identity, occupiedPrefixes)).toThrow(
    "Could not allocate a unique search session id.",
  );
});

test("search session ids ignore the presentation budget", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-session-"));
  const source = path.join(cwd, "source.txt");
  await writeFile(source, "needle\n", "utf8");
  const matches: readonly TextSearchMatch[] = [
    {
      source,
      lineNumber: 1,
      startColumn: 0,
      endColumn: 6,
      matchedText: "needle",
      lineText: "needle",
    },
  ];
  const first = createSearchSessionId("needle", matches, cwd, {
    query: "needle",
    regex: true,
    path: ".",
    limit: 1,
  });
  const second = createSearchSessionId("needle", matches, cwd, {
    query: "needle",
    regex: true,
    path: ".",
    limit: 10,
  });
  expect(first).toBe(second);

  const store = new SearchSessionStore();
  await store.register("needle", matches, true, cwd, undefined, {
    query: "needle",
    regex: true,
    path: ".",
    limit: 1,
  });
  await store.register("needle", matches, true, cwd, undefined, {
    query: "needle",
    regex: true,
    path: ".",
    limit: 10,
  });
  const resolver = store.resourceResolver();
  await expect(resolver.tryResolve(`SEARCH#${first}:1:match`, { cwd })).resolves.toMatchObject({
    kind: "resolved",
  });
});

test("refreshes all matches beyond the presentation budget", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-refresh-"));
  const first = path.join(cwd, "first.txt");
  const second = path.join(cwd, "second.txt");
  await writeFile(first, "needle first\n", "utf8");
  await writeFile(second, "nothing\n", "utf8");
  const match: TextSearchMatch = {
    source: first,
    lineNumber: 1,
    startColumn: 0,
    endColumn: 6,
    matchedText: "needle",
    lineText: "needle first",
  };
  const store = new SearchSessionStore();
  const session = await store.register("needle", [match], true, cwd, undefined, {
    query: "needle",
    regex: true,
    limit: 1,
  });
  await writeFile(first, "changed needle first\n", "utf8");
  await writeFile(second, "needle second\n", "utf8");

  const resolver = store.resourceResolver();
  const firstAttempt = await resolver.tryResolve(`SEARCH#${session.id}:all:match`, { cwd });
  expect(firstAttempt).toMatchObject({ kind: "resolved" });

  await writeFile(first, "needle first\n", "utf8");
  const retry = await resolver.tryResolve(`SEARCH#${session.id}:all:match`, { cwd });
  expect(retry).toMatchObject({ kind: "resolved" });
});

test("refreshes a fallback search with literal-first semantics", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-fallback-refresh-"));
  const source = path.join(cwd, "source.txt");
  await writeFile(source, "alpha alone\nbeta alone\n", "utf8");
  const store = new SearchSessionStore();
  const session = await store.register(
    "(?:alpha|beta)",
    [
      {
        source,
        lineNumber: 1,
        startColumn: 0,
        endColumn: 5,
        matchedText: "alpha",
        lineText: "alpha alone",
      },
      {
        source,
        lineNumber: 2,
        startColumn: 0,
        endColumn: 4,
        matchedText: "beta",
        lineText: "beta alone",
      },
    ],
    true,
    cwd,
    undefined,
    {
      query: "alpha beta",
      regex: true,
      fallbacks: [{ query: "(?:alpha|beta)", mode: "words" }],
    },
  );
  await writeFile(source, "alpha beta together\nalpha alone\n", "utf8");

  await expect(
    store.resourceResolver().tryResolve(`SEARCH#${session.id}:all:match`, { cwd }),
  ).resolves.toMatchObject({
    kind: "resolved",
    targets: [
      {
        source,
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: { lineNumber: 1, column: 10 },
          },
        ],
      },
    ],
  });
});

test("resolves typed search targets with deduplicated whole-line ranges", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-targets-"));
  const source = path.join(cwd, "source.txt");
  await writeFile(source, "needle needle\ntail\n", "utf8");
  const matches: readonly TextSearchMatch[] = [
    {
      source,
      lineNumber: 1,
      startColumn: 0,
      endColumn: 6,
      matchedText: "needle",
      lineText: "needle needle",
    },
    {
      source,
      lineNumber: 1,
      startColumn: 7,
      endColumn: 13,
      matchedText: "needle",
      lineText: "needle needle",
    },
  ];
  const store = new SearchSessionStore();
  const session = await store.register("needle", matches, true, cwd, undefined, {
    query: "needle",
    regex: true,
  });
  const resolver = store.resourceResolver();

  await expect(
    resolver.tryResolve(`SEARCH#${session.id}:all:line`, { cwd }),
  ).resolves.toMatchObject({
    kind: "resolved",
    targets: [
      {
        source,
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: { lineNumber: 2, column: 0 },
            linewise: true,
          },
        ],
      },
    ],
  });

  await expect(
    resolver.tryResolve(`SEARCH#${session.id}:all:match`, { cwd }),
  ).resolves.toMatchObject({
    kind: "resolved",
    targets: [
      {
        source,
        ranges: [{ start: { lineNumber: 1, column: 0 } }, { start: { lineNumber: 1, column: 7 } }],
      },
    ],
  });
});

test("all selections refresh through the original backend while single selections stay stale", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-backend-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "source.txt");
  await writeFile(source, "old\n");
  const store = new SearchSessionStore();
  let refreshes = 0;
  const session = await store.register(
    "ast:node",
    [searchMatch(source, "old")],
    true,
    cwd,
    undefined,
    { query: "ast:node", regex: false },
    async () => {
      refreshes++;
      return { matches: [searchMatch(source, "new")], complete: true };
    },
  );
  await writeFile(source, "new\n");
  await expect(
    store.resourceResolver().tryResolve(`SEARCH#${session.id}:1:match`, { cwd }),
  ).resolves.toMatchObject({ kind: "rejected", rejection: { code: "stale" } });
  await expect(
    store.resourceResolver().tryResolve(`SEARCH#${session.id}:all:match`, { cwd }),
  ).resolves.toMatchObject({ kind: "resolved", targets: [{ expectedContent: "new\n" }] });
  expect(refreshes).toBe(1);
  const observations = await store.observeAfterEdit([`SEARCH#${session.id}:all:match`]);
  expect(observations).toMatchObject([{ matches: 1, complete: true }]);
  expect(refreshes).toBe(2);
});

test("multiline all-line selections deduplicate overlapping containing lines", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-multiline-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "source.txt");
  await writeFile(source, "call(\n x\n)\n");
  const store = new SearchSessionStore();
  const session = await store.register(
    "nodes",
    [
      {
        source,
        lineNumber: 1,
        endLineNumber: 3,
        startColumn: 0,
        endColumn: 1,
        matchedText: "call(\n x\n)",
        lineText: "call(",
      },
      { source, lineNumber: 2, startColumn: 1, endColumn: 2, matchedText: "x", lineText: " x" },
    ],
    true,
    cwd,
  );
  const resolved = await store
    .resourceResolver()
    .tryResolve(`SEARCH#${session.id}:all:line`, { cwd });
  expect(resolved.kind).toBe("resolved");
  if (resolved.kind !== "resolved") throw new Error("Missing selection");
  expect(resolved.targets[0]?.ranges?.map((range) => range.start.lineNumber)).toEqual([1, 2, 3]);
});
