import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ResultTargetStore } from "pi-agent-resource";
import { expect, onTestFinished, test } from "vitest";

import { createTextResolver } from "#src/resolvers.ts";
import { searchText, searchTextContent } from "#src/search-backend.ts";
import { SearchSessionStore } from "#src/search-session.ts";
import type { SearchToolDetails } from "#src/search-result.ts";

// Only LF ends a line. CR, a lone CR and a BOM are ordinary characters of their line, exactly as
// the editor counts them, so every position here is checked against the bytes on disk.
const content = "\uFEFFalpha one\r\nbeta\rtwo\nlast\r\nend";

/** Offset of a 1-based line and 0-based column, with lines split at LF only. */
function offsetOf(text: string, position: { lineNumber: number; column: number }): number {
  let start = 0;
  for (let line = 1; line < position.lineNumber; line += 1) start = text.indexOf("\n", start) + 1;
  return start + position.column;
}

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-byte-exact-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "bomb.txt");
  await writeFile(source, content);
  return { cwd, source };
}

/** The text each range of a registered reference selects in the text it was registered with. */
async function selectedText(sessions: SearchSessionStore, reference: string, cwd: string) {
  const attempt = await sessions.resourceResolver().tryResolve(reference, { cwd });
  if (attempt.kind !== "resolved") throw new Error(JSON.stringify(attempt));
  return attempt.targets.flatMap((target) =>
    (target.ranges ?? []).map((range) => {
      const text = target.expectedContent ?? "";
      return text.slice(offsetOf(text, range.start), offsetOf(text, range.end));
    }),
  );
}

async function search(query: string, options: { regex?: boolean; multiline?: boolean } = {}) {
  const { cwd } = await workspace();
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const resolver = createTextResolver(sessions);
  const context = { cwd, signal: new AbortController().signal };
  const resolved = await resolver.tryResolve(
    { query, path: "bomb.txt", ...(options.multiline === true && { multiline: true }) },
    context,
  );
  if (resolved.kind !== "resolved") throw new Error(`Expected matches, got ${resolved.kind}`);
  const details = (await resolver.format(resolved.payload, context)).details as SearchToolDetails;
  const id = String(details.sessionId);
  return {
    match: await selectedText(sessions, `SEARCH#${id}:1:match`, cwd),
    line: await selectedText(sessions, `SEARCH#${id}:1:line`, cwd),
  };
}

test("backend positions count a BOM, CRLF and a lone CR as ordinary characters", async () => {
  const { cwd } = await workspace();
  const { matches } = await searchText({ query: "alpha|two|last|end", regex: true }, cwd);

  expect(
    matches.map((match) => [match.lineNumber, match.startColumn, match.endColumn, match.lineText]),
  ).toEqual([
    [1, 1, 6, "\uFEFFalpha one\r"],
    [2, 5, 8, "beta\rtwo"],
    [3, 0, 4, "last\r"],
    [4, 0, 3, "end"],
  ]);
  for (const match of matches)
    expect(
      content.slice(
        offsetOf(content, { lineNumber: match.lineNumber, column: match.startColumn }),
        offsetOf(content, {
          lineNumber: match.endLineNumber ?? match.lineNumber,
          column: match.endColumn,
        }),
      ),
    ).toBe(match.matchedText);
});

test("a match next to the BOM selects exactly its characters, and its line keeps the BOM", async () => {
  expect(await search("alpha")).toEqual({ match: ["alpha"], line: ["\uFEFFalpha one\r\n"] });
});

test("a match after a lone CR selects its characters on the same line", async () => {
  expect(await search("two")).toEqual({ match: ["two"], line: ["beta\rtwo\n"] });
});

test("a match that covers a CR selects the CR too", async () => {
  expect(await search("one\r", { multiline: true })).toEqual({
    match: ["one\r"],
    line: ["\uFEFFalpha one\r\n"],
  });
});

test("a multiline match across CRLF selects exactly the matched bytes and its whole lines", async () => {
  expect(await search("one\r\nbeta\rt", { multiline: true })).toEqual({
    match: ["one\r\nbeta\rt"],
    line: ["\uFEFFalpha one\r\nbeta\rtwo\n"],
  });
});

test("a match on the last line without a final line break selects only that line", async () => {
  expect(await search("end")).toEqual({ match: ["end"], line: ["end"] });
});

test("a UTF-16LE file with a BOM is still found, as ripgrep transcodes it", async () => {
  const { cwd } = await workspace();
  const source = path.join(cwd, "script.ps1");
  await writeFile(
    source,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Write-Host found\r\n", "utf16le")]),
  );

  const { matches } = await searchText({ query: "found", path: "script.ps1" }, cwd);

  // Transcoded text has no UTF-8 BOM, so its columns are left as ripgrep reports them.
  expect(matches.map((match) => [match.source, match.lineNumber, match.startColumn])).toEqual([
    [source, 1, 11],
  ]);
});

test("a search of captured text keeps line 1's BOM in its positions", async () => {
  const { matches } = await searchTextContent(
    { query: "alpha|one\\r\\nbeta", regex: true, multiline: true },
    content,
    process.cwd(),
  );

  expect(
    matches.map((match) => [
      match.lineNumber,
      match.startColumn,
      match.endLineNumber ?? match.lineNumber,
      match.endColumn,
      match.lineText,
    ]),
  ).toEqual([
    [1, 1, 1, 6, "\uFEFFalpha one\r"],
    [1, 7, 2, 4, "\uFEFFalpha one\r"],
  ]);
});
