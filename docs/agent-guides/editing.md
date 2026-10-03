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

## Editing returned targets

Pass a source-aware result, its `data`, a `RESULT#` reference, or an array of returned matches to the supported input field. Omit the corresponding string selectors. An ordinary file Read target selects its requested whole-line window; a Read of a `RESULT#` target stays within the original exact scope. A Search target selects exact matches. Pass a filtered matches array to edit a subset, rather than changing a whole result's preview.

- `replace.path` replaces exact ranges. `delete.path` removes exact ranges but keeps the file, even for a whole-file selection.
- `write.path` and `undo.file` require one whole-file target. Partial and multi-file scopes are rejected, not widened.
- `copy.path` / `move.path` select source ranges; `target` selects exact destination ranges. A zero-width destination inserts. Structured source/destination arrays pair in declared order with equal counts; duplicates are removed. Unequal counts and overlapping moves are rejected.
- With an ordinary string destination and no text selectors, copy/move require one whole-file source and keep byte-preserving file behavior. String destinations with `targetStart` / `targetEnd` keep their line-based semantics.
- `insert` still uses its string path and anchors; it does not accept an arbitrary structured input.

A replace/insert result selects that call's resulting text, including supplied line separators. Empty replacement selects the resulting position, not the removed text. Copy/move results select only destination text, never source removals. Whole-file transfers and write select the whole destination; undo selects whole restored files. Delete returns an inspection record, never a live text target. Check `data.target` before composing; `data.targetUnavailable` explains missing verified text mapping. Binary file operations can succeed without text targets.

New targets are strict snapshots. Obtain fresh targets after source bytes change, the session changes, or Pi reloads. Incomplete, unsupported and expired inputs are rejected before writing. Empty replace/delete/paired transfer selections are successful no-ops with `effect: "not-applied"`; whole-file write/undo still require one file. Existing string `SEARCH#:all` refresh behavior is unchanged. Removal records, diff text and arbitrary coordinates are not live targets.

## Choosing line separation

Use `separation: "blank-line"` for a separate paragraph or section; use the default line mode for adjacent code lines, list items, or a continuation of the current block. For example, inserting `X` after `A` in `A\nB` with blank-line separation produces `A\n\nX\n\nB`. In Apply, pass `{ separation: "blank-line" }` as the third argument to a linewise `insertAfter` or `insertBefore`.

## Standalone mutation behavior

Batch independent mutations as separate tool calls in one assistant response. Every call in that batch is evaluated against the original file contents. Combine overlapping changes into one mutation. A rejected call does not cancel successful independent calls; retry only what was not applied.

When a text tool allows an omitted path, it can inherit the source identified by its anchor, the last read, or the preceding edit in the same batch. Supply the path when that inheritance would be ambiguous.

Use `delete` with an ordinary string path and no text selector to delete one complete file. Use a selector or structured path to remove text. Use `copy` or `move` with ordinary paths and no text selectors for whole-file operations; add selectors or structured destinations for text transfers.

## Native Codemode

Check each IDE result's `status` before using its data. Structured domain errors resolve to `status: "error"` or `"partial"`; argument validation, blocking, and cancellation can still reject. Check `data.effect` and per-source effects before retrying.

Await `tools.flush({})` when later script work needs a committed receipt. Inspect its `data.operations` for final effects keyed by accepted child call ID. A failed flush does not replay edits. An empty flush succeeds with no operations.

Await independent local text-edit calls sequentially inside one script. Keep their selectors tied to the original file snapshots and combine overlapping edits before submitting them. Check the parent Codemode result for committed effects; a child acceptance is not proof that a file was written.

Pass a pending replace/insert/write/copy/move result directly to Search or a supported mutation input for dependent work. That boundary commits the batch and confirms its target before the dependent tool runs. The original child receipt remains `effect: "pending"`; use flush or the parent receipt for final effects. A failed or cancelled operation never grants editable targets. Another tool, a whole-file operation, or a resource-owned selector also ends the batch. Do not reuse old line anchors across that boundary.

Formatting and registered resource post-edit handlers run once per surviving resource after all calls in one native Codemode script. Reads and dependent searches inside that script see written but not yet formatted text. Flush commits writes, not final formatting. If final processing changes bytes, earlier targets are stale; repeat Read/Search. Standalone calls outside Codemode still finish post-edit work immediately.

Inspect final results after an ordinary script error and retry only unapplied edits. Abort or deadline discards pending writes, not batches that already committed.

## Specialized resources

Some resources attach non-text actions to the same tools:

- `shell:<session>` — `write` sends exact input, `insert` sends named keys, and `delete` terminates the session.
- `debug:<session>` — `insert` controls the debugger and `delete` removes a breakpoint or terminates the session.
- `symbol:<file>#<selector>#name` — `replace` performs a native language-server rename when available.

Read `docs:terminal`, `docs:debugger`, or `docs:search-code` before using those specialized resources.

Never guess after a stale snapshot, empty selection, ambiguous target, or unknown rollback effect.
