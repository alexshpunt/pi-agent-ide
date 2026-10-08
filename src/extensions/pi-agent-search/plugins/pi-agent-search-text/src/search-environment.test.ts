import { expect, test } from "vitest";
import { searchText } from "#src/search-backend.js";
import { searchFuzzy } from "#src/fuzzy-search.js";
import { SearchSessionStore } from "#src/search-session.js";
import { createTextResolver } from "#src/resolvers.js";
import type { SearchEnvironment } from "pi-agent-search/api/search";

test("fuzzy alternatives collect names and verify exact matches on their original owner", async () => {
  const { environment, calls } = fixture();
  const probes: string[] = [];
  environment.byteSize = async (source) => {
    probes.push(source);
    return Buffer.byteLength("café needle\n");
  };
  const originalRun = environment.runLines;
  environment.runLines = async (args, cwd, onLine, signal) => {
    if (args.includes("--only-matching")) {
      calls.push([...args]);
      onLine("needle");
      return { code: 0, stderr: "" };
    }
    return originalRun(args, cwd, onLine, signal);
  };
  const result = await searchFuzzy(
    { query: "nedle", path: "memory://owner/work" },
    "/local",
    undefined,
    environment,
  );
  expect(result).toMatchObject({
    status: "ready",
    candidates: [
      {
        identifier: "needle",
        matches: [{ source: "memory://owner/work/note.txt", matchedText: "needle" }],
      },
    ],
  });
  expect(calls[0]).toContain("--only-matching");
  expect(calls[1]).toContain("--fixed-strings");
  expect(calls[1]).toContain("needle");
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every((source) => source === "memory://owner/work/note.txt")).toBe(true);
});

test("fuzzy search refuses an owner that cannot bound its source snapshots before scanning", async () => {
  const { environment, calls } = fixture();
  expect(
    await searchFuzzy(
      { query: "nedle", path: "memory://owner/work" },
      "/local",
      undefined,
      environment,
    ),
  ).toMatchObject({
    status: "skipped",
    candidates: [],
    message: "source owner cannot bound candidate snapshots",
  });
  expect(calls).toEqual([]);
});

// A non-filesystem owner proves no source is normalized or read through local fs.
function fixture(): {
  environment: SearchEnvironment;
  calls: string[][];
  setText(text: string): void;
} {
  let content = "café needle\n";
  const calls: string[][] = [];
  const environment: SearchEnvironment = {
    resolve: (cwd, source) =>
      source.startsWith("memory://") ? source : new URL(source, `${cwd}/`).href,
    dirname: (source) => source.slice(0, source.lastIndexOf("/")),
    basename: (source) => source.slice(source.lastIndexOf("/") + 1),
    isDirectory: async (source) => source === "memory://owner/work",
    readText: async () => content,
    async runLines(arguments_, _cwd, onLine) {
      calls.push([...arguments_]);
      onLine(
        JSON.stringify({
          type: "match",
          data: {
            path: { text: "note.txt" },
            lines: { text: content },
            line_number: 1,
            submatches: [
              {
                start: Buffer.from(content).indexOf("needle"),
                end: Buffer.from(content).indexOf("needle") + 6,
              },
            ],
          },
        }),
      );
      return { code: 0, stderr: "" };
    },
  };
  return {
    environment,
    calls,
    setText(text) {
      content = text;
    },
  };
}

test("text search uses the owner executor and canonical Unicode ranges", async () => {
  const { environment, calls } = fixture();
  const result = await searchText(
    { query: "needle", path: "memory://owner/work" },
    "/local",
    undefined,
    undefined,
    environment,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--fixed-strings");
  expect(result.matches[0]).toMatchObject({
    source: "memory://owner/work/note.txt",
    startColumn: 5,
    endColumn: 11,
    matchedText: "needle",
  });
});

test("SEARCH selections retain their owner for snapshots and stale checks", async () => {
  const { environment, setText } = fixture();
  const store = new SearchSessionStore();
  const resolver = createTextResolver(store);
  const context = { cwd: "memory://owner/work", environment };
  const attempt = await resolver.tryResolve({ query: "needle" }, context);
  expect(attempt.kind).toBe("resolved");
  if (attempt.kind !== "resolved") throw new Error("Expected owner search");
  const result = await resolver.format(attempt.payload, context);
  const id = (result.details as { sessionId: string }).sessionId;
  expect(id).toBeTypeOf("string");
  const anchor = `SEARCH#${id}:1:match`;
  expect(
    await store.anchorResolver().tryResolve(anchor, {
      source: "memory://owner/work/note.txt",
      content: "café needle\n",
      lines: ["café needle"],
      cwd: context.cwd,
    }),
  ).toMatchObject({ kind: "resolved" });
  setText("external\n");
  expect(
    await store.anchorResolver().tryResolve(anchor, {
      source: "memory://owner/work/note.txt",
      content: "café needle\n",
      lines: ["café needle"],
      cwd: context.cwd,
    }),
  ).toMatchObject({ kind: "rejected" });
});

test("a complete SEARCH selection refreshes through its original owner", async () => {
  const { environment, calls, setText } = fixture();
  const store = new SearchSessionStore();
  const context = { cwd: "memory://owner/work", environment };
  const resolver = createTextResolver(store);
  const attempt = await resolver.tryResolve({ query: "needle" }, context);
  if (attempt.kind !== "resolved") throw new Error("Expected owner search");
  const result = await resolver.format(attempt.payload, context);
  const id = (result.details as { sessionId: string }).sessionId;
  setText("prefix café needle\n");
  expect(
    await store.anchorResolver().tryResolve(`SEARCH#${id}:all:match`, {
      source: "memory://owner/work/note.txt",
      content: "café needle\n",
      lines: ["café needle"],
      cwd: context.cwd,
    }),
  ).toMatchObject({ kind: "resolved" });
  expect(calls.length).toBeGreaterThan(1);
});
