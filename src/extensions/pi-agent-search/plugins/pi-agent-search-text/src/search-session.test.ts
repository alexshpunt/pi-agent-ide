import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

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

test("search session ids include the complete recipe and cwd", async () => {
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
  expect(first).not.toBe(second);

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
  await expect(resolver.tryResolve(`SEARCH#${second}:1:match`, { cwd })).resolves.toMatchObject({
    kind: "resolved",
  });
});

test("does not reuse an incomplete refreshed all snapshot after retry", async () => {
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
  expect(firstAttempt).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });

  await writeFile(first, "needle first\n", "utf8");
  const retry = await resolver.tryResolve(`SEARCH#${session.id}:all:match`, { cwd });
  expect(retry).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
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
