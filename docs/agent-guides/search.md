# Search

## Queries

- Plain text is literal. If nothing matches, unquoted input is retried as a regex, then as separate words. The result says when it broadened; treat broadened matches as location hints, not edit targets. Quoted text stays literal.
- Boolean: uppercase `AND`, `OR`, infix `NOT`, `||` or a spaced `|`; parentheses group. `regex:<pattern>` forces a regex.
- A match stays on one line. `multiline: true` lets it span lines, and `.` then matches line breaks. Boolean queries are always single-line.
- Narrow with `path`, `include` and `exclude` before broadening. Find files by name with `file_search`.
- After zero matches, an identifier can get "possible names": spelling hints in the same scope, each with its own references. They are not equivalents; read a candidate before editing it.

## Results

- Each match has `SEARCH#HASH:N:line` (its line) and `SEARCH#HASH:N:match` (the exact match). `:all:line` and `:all:match` select every match, across files. Pass them to `read` or an edit tool as they are.
- A single reference goes stale when its file changes; search again. An `:all` reference re-runs its query instead.
- In Codemode, search returns `{ result, hasMatches, complete }`: pass `result` on. `hasMatches: false` proves absence only when `complete` is `true`.
- A failed or interrupted search is not zero matches.

## Search inside a result

Pass an unchanged Read/Search/edit result as `path` to search only its ranges; gaps between ranges and `include`/`exclude` don't apply. Use it to narrow a selection before editing, for example the text between two markers:

```js
const section = await tools.read({ path: "notes.md", offset: 20, limit: 40 });
const body = await tools.search({
  path: section,
  query: "regex:(?<=<!-- START -->\\n).*?(?=<!-- END -->)",
  multiline: true,
});
await tools.replace({ path: body.result, text: "new body\n" });
```

For syntax structure, use `ast_search` on the same result.

## Other sources

- `docs:all` or `docs:<id>`: guide text, literal or `regex:`. Read the guide for full context.
- An HTTP(S) URL or `web:ssh://<target>/https://…`: page text, no read needed first. Matches have no edit references.
- `shell:<session>`: terminal output beyond the tail.
