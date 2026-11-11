import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ResultTargetStore } from "pi-agent-resource";
import { expect, onTestFinished, test } from "vitest";

import { createTextResolver } from "#src/resolvers.ts";
import { SearchSessionStore } from "#src/search-session.ts";
import type { SearchToolDetails } from "#src/search-result.ts";

// Another session writes the file between the backend search and the registration of its anchors.
const original = [
  "#include <vector>",
  "void first() { rename_me(1); }",
  "void second() { rename_me(2); }",
  "void third() { keep_me(3); }",
];

const text = (...rows: readonly string[]) => `${rows.join("\n")}\n`;

/** The projection a Codemode script receives, as far as these cases read it. */
interface ScriptData {
  readonly complete: boolean;
  readonly notices: readonly string[];
  readonly matches: readonly {
    readonly range: { readonly startLine: number };
    readonly matchedText?: string;
    readonly target?: string;
    readonly references?: { readonly line: string; readonly match: string };
  }[];
}

async function searchWhileWriting(write: (source: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-registration-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, text(...original));
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const resolver = createTextResolver(sessions);
  const context = { cwd, signal: new AbortController().signal };
  const resolved = await resolver.tryResolve({ query: "rename_me", path: "main.cpp" }, context);
  if (resolved.kind !== "resolved") throw new Error(`Expected matches, got ${resolved.kind}`);
  await write(source);
  const format = async () => {
    const output = await resolver.format(resolved.payload, context);
    const details = output.details as SearchToolDetails & { readonly target?: string };
    return {
      text: output.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
      details,
      /** What a Codemode script receives for the same call. */
      data: resolver.toScriptData?.(resolved.payload, details) as ScriptData,
    };
  };
  return { cwd, source, sessions, format };
}

/** Ranges of a registered reference, with the line text each one selects in the current file. */
async function selected(sessions: SearchSessionStore, reference: string, cwd: string) {
  const attempt = await sessions.resourceResolver().tryResolve(reference, { cwd });
  if (attempt.kind !== "resolved") throw new Error(JSON.stringify(attempt));
  return attempt.targets.flatMap((target) => {
    const rows = (target.expectedContent ?? "").split("\n");
    return (target.ranges ?? []).map((range) =>
      [
        String(range.start.lineNumber),
        (rows[range.start.lineNumber - 1] ?? "").slice(range.start.column, range.end.column),
      ].join(":"),
    );
  });
}

test("a search registers anchors for lines a concurrent writer only moved", async () => {
  const { cwd, sessions, format } = await searchWhileWriting((source) =>
    writeFile(source, text("// peer 1", ...original)),
  );
  const { text: output, details } = await format();

  expect(details.target).toBeDefined();
  expect(details.sessionId).toBeDefined();
  expect(output).toContain(`SEARCH#${String(details.sessionId)}:all:line`);
  expect(output).not.toContain("without anchors");
  // The anchors describe the file as it is now: every match moved down by the inserted line.
  expect(await selected(sessions, `SEARCH#${String(details.sessionId)}:all:match`, cwd)).toEqual([
    "3:rename_me",
    "4:rename_me",
  ]);
  expect(details.matchCount).toBe(2);
  expect(details.complete).toBe(true);
});

test("a search reports the matches of the text it registers when a match disappears", async () => {
  const { cwd, sessions, format } = await searchWhileWriting((source) =>
    writeFile(
      source,
      text("// peer 1", original[0] ?? "", "void first() { renamed(1); }", ...original.slice(2)),
    ),
  );
  const { text: output, details, data } = await format();

  expect(details.target).toBeDefined();
  expect(output).not.toContain("without anchors");
  expect(await selected(sessions, `SEARCH#${String(details.sessionId)}:all:match`, cwd)).toEqual([
    "4:rename_me",
  ]);
  expect(details.matchCount).toBe(1);
  // A script sees the same matches its anchors point at, not the ones the backend returned.
  expect(data.matches.map((match) => match.range.startLine)).toEqual([4]);
  expect(data.matches[0]?.references?.match).toBe(`SEARCH#${String(details.sessionId)}:1:match`);
  expect(data.matches[0]?.target).toBeDefined();
  expect(data.complete).toBe(true);
});

test("a search leaves out a source it cannot read any more and says so", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-registration-gone-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "main.cpp"), text(...original));
  await writeFile(path.join(cwd, "gone.cpp"), text("void fourth() { rename_me(4); }"));
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const resolver = createTextResolver(sessions);
  const context = { cwd, signal: new AbortController().signal };
  const resolved = await resolver.tryResolve({ query: "rename_me" }, context);
  if (resolved.kind !== "resolved") throw new Error(`Expected matches, got ${resolved.kind}`);
  await rm(path.join(cwd, "gone.cpp"));

  const output = await resolver.format(resolved.payload, context);
  const details = output.details as SearchToolDetails;
  const data = resolver.toScriptData?.(resolved.payload, details) as ScriptData;

  expect(details.matchCount).toBe(2);
  expect(data.matches.map((match) => match.range.startLine)).toEqual([2, 3]);
  expect(data.complete).toBe(false);
  expect(data.notices.join("\n")).toContain("gone.cpp");
});

test("a search in a result scope registers the matches of the current scope text", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-registration-scope-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, text(...original));
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const resolver = createTextResolver(sessions);
  const scopeOf = (content: string) => ({
    complete: true,
    targets: [
      {
        source,
        expectedContent: content,
        readCurrent: async () => readFile(source, "utf8"),
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: {
              lineNumber: content.split("\n").length - 1,
              column: (content.split("\n").at(-2) ?? "").length,
            },
          },
        ],
      },
    ],
  });
  const context = {
    cwd,
    signal: new AbortController().signal,
    scope: scopeOf(text(...original)),
    rescope: async () => scopeOf(await readFile(source, "utf8")),
  };
  const resolved = await resolver.tryResolve({ query: "rename_me", path: "main.cpp" }, context);
  if (resolved.kind !== "resolved") throw new Error(`Expected matches, got ${resolved.kind}`);
  await writeFile(source, text("// peer 1", ...original));
  const output = await resolver.format(resolved.payload, context);
  const details = output.details as SearchToolDetails & { readonly target?: string };

  expect(details.target).toBeDefined();
  expect(await selected(sessions, `SEARCH#${String(details.sessionId)}:all:match`, cwd)).toEqual([
    "3:rename_me",
    "4:rename_me",
  ]);
});

test("a search fails with a reason when the matched file cannot be read any more", async () => {
  const { format } = await searchWhileWriting((source) => rm(source));
  await expect(format()).rejects.toThrow(/main\.cpp/u);
});
