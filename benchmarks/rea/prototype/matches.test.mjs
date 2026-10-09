import assert from "node:assert/strict";
import { test } from "node:test";
import { literalMatches } from "./matches.mjs";

test("IPC channels and regex punctuation are literal text", () => {
  const text = "catalog:search\r\ncatalog.search(a)\r\ncatalogXsearch";
  const channel = [...literalMatches(text, "catalog:search")];
  assert.equal(channel.length, 1);
  assert.equal(channel[0].lineNumber, 1);
  const dotted = [...literalMatches(text, "catalog.search(a)")];
  assert.equal(dotted.length, 1);
  assert.equal(dotted[0].lineNumber, 2);
  assert.equal(dotted[0].matchedText, "catalog.search(a)");
});

test("whole words use immediate Unicode neighbors and UTF-16 columns", () => {
  const text = "𐐀rank rank𐐀 rank.x RANK rank_extra";
  const found = [...literalMatches(text, "rank", { wholeWord: true })];
  assert.deepEqual(
    found.map((hit) => hit.matchedText),
    ["rank", "RANK"],
  );
  assert.deepEqual(
    found.map((hit) => hit.startColumn),
    [14, 21],
  );
  assert.equal(
    [...literalMatches(text, "rank", { wholeWord: true, caseSensitive: true })].length,
    1,
  );
});
