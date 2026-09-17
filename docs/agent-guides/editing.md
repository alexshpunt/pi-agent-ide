# Precise text editing

Use standalone `replace`, `insert`, `delete`, `copy`, and `move` whenever each intended change is known in advance and does not depend on another change. Submit several independent edits together as separate tool calls in one assistant response, whether they affect one file or several files.

Use `apply` only when the work requires computation, conditions, selection composition, checkpoints, or one coherent cross-file transaction. Do not replace a straightforward standalone batch with a JavaScript Apply program. Read `docs:apply` before writing an Apply script.

Use `write` only to create a file or deliberately replace its complete contents. Use `diff` for read-only comparison.

## Selecting text

Use a returned anchor when it identifies the intended text. Otherwise use the smallest unique exact string.

Supported selectors include:

- `LINE#HASH` — one current source line returned by the `anchors` view.
- `scope-begin-HASH` and `scope-end-HASH` — syntax-scope boundaries returned by the `ast` view.
- `SEARCH#...:line` — the complete containing line of a search result.
- `SEARCH#...:match` — only the exact search match.
- `begin` and `end` — the first and last existing source lines.
- A unique exact string — that text fragment itself.

With an `end` selector, the operation covers complete lines from the first line containing `start` through the last line containing `end`, inclusive. Without `end`, an exact string targets only that fragment, while a line or structured anchor targets its selected line or range.

Selections are revision-sensitive. Re-read after a mutation before reusing a single-file line, scope, or search anchor. Complete `SEARCH#...:all` selections can refresh their original query.

## Standalone mutation behavior

Batch independent mutations as separate tool calls in one assistant response. Every call in that batch is evaluated against the original file contents. Combine overlapping changes into one mutation. A rejected call does not cancel successful independent calls; retry only what was not applied.

When a text tool allows an omitted path, it can inherit the source identified by its anchor, the last read, or the preceding edit in the same batch. Supply the path when that inheritance would be ambiguous.

Use `delete` with a path and no text selector to delete one complete file. Use a selector to remove text. Use `copy` or `move` with no text selectors for whole-file operations; add source and destination selectors for text transfers.

## Specialized resources

Some resources attach non-text actions to the same tools:

- `shell:<session>` — `write` sends exact input, `insert` sends named keys, and `delete` terminates the session.
- `debug:<session>` — `insert` controls the debugger and `delete` removes a breakpoint or terminates the session.
- `symbol:<file>#<selector>#name` — `replace` performs a native language-server rename when available.

Read `docs:terminal`, `docs:debugger`, or `docs:search-code` before using those specialized resources.

Never guess after a stale snapshot, empty selection, ambiguous target, or unknown rollback effect.
