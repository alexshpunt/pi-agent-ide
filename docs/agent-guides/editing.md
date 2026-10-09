# Precise text editing

Use standalone `replace`, `insert`, `delete`, `copy`, and `move` when each change is known in advance and does not depend on another change. Submit independent calls together in one response. Use native Codemode for computed or dependent composition; it does not add grouped rollback.

Use `write` only to create a file or deliberately replace all its contents. Use `diff` for read-only comparison.

## Select the intended text

Use a returned anchor when it identifies the intended text. Otherwise use the smallest unique exact string.

- `LINE#HASH` selects a current source line from the `anchors` view.
- `scope-begin-HASH` and `scope-end-HASH` mark syntax boundaries from the `ast` view.
- `SEARCH#...:line` selects a complete containing line; `SEARCH#...:match` selects the exact match.
- `begin` and `end` select the first and last existing lines.
- A unique exact string selects that fragment.

With `end`, the operation covers complete lines from the first line containing `start` through the last line containing `end`, inclusive. Without `end`, an exact string selects just that fragment.

After an exact-text selector fails, exact-text edits are blocked for that file. Find the intended location among the returned current anchors, or use Read/Search for another section. Edit with its anchor. After that edit succeeds, exact text is available again. Do not retry a guessed string.

Re-read after a mutation before reusing line, scope, or individual Search anchors. Complete `SEARCH#...:all` selections retain their existing query-refresh behavior.

## Compose results

Results are readable text with a leading system-result envelope. The envelope is an internal reference, not file content. Do not edit it or write it into a file. Pass the unchanged result to another source parameter; outside Codemode you can also pass its UUID. Store/load keeps the same string in the current session. No internal fields need to be inspected.

Read results select their requested source windows. Search results select exact matches. Select derives new boundaries. A displayed item reference selects that item; the whole result retains all selections, including those omitted from its preview.

- `replace.path` replaces selected ranges. `delete.path` removes selected text but keeps the file, even for a whole-file selection.
- `write.path` and `undo.file` require one whole-file selection. Partial and multi-file scopes are rejected, not widened.
- `copy.path` / `move.path` select source ranges; `target` selects destination ranges. A zero-width destination inserts. Arrays pair in declared order, with equal counts and duplicates removed. Unequal counts and overlapping moves are rejected.
- Move succeeds without writes for valid empty arrays and paired zero-width selections. Empty arrays return no selection; paired points return only the unchanged destination points. The usual validation and overlap guards still apply.
- Ordinary filesystem paths without selectors copy or move one whole object: a regular file, directory tree, or symlink. Result inputs remain text selections; a directory listing does not authorize a whole-directory transfer.
- `insert` uses line-based insertion before or after its selected containing lines.

Replace/insert results select their resulting text, including supplied line separators. Empty replacement selects the resulting position, not removed text. Copy/move results select only destination text. Whole regular-text-file transfers and write select the whole destination; undo selects restored files. Delete and binary operations provide no reusable text selection. If a result cannot supply a verified selection, inspect the file instead.

Results are strict snapshots. Changed files permanently retire their old IDs, even if the old bytes are restored later. Session changes and reloads also retire IDs. Empty selections are valid no-ops; incomplete or expired selections cannot authorize edits. Diff text and invented coordinates do not grant source authority.

## Whole filesystem objects

Use ordinary paths without text selectors for whole-object Delete, Copy, and Move. Delete removes directory contents recursively and unlinks symlinks without following their targets. Copy merges directory contents into the exact target directory and keeps destination-only entries. Move replaces an existing target directory and removes destination-only entries. Both transfers create missing parents, preserve file bytes and symlink text, and reject symlink destinations, type conflicts, and overlapping trees. Relative links keep their text; moving them can change what they point to.

Directory and symlink transfers have no reusable text selection. Read their ordinary paths to inspect them. A failure before filesystem execution reports `not-applied`; a failure after execution starts reports `unknown`. Inspect both paths before retrying an unknown transfer. Recursive transfers and cross-device Move have no atomic rollback. Cancellation before execution prevents a transfer; in-flight filesystem work may finish.

## Line separation

Use `separation: "blank-line"` for a separate paragraph or section; use default line mode for adjacent code, list items, or a continuation. Inserting `X` after `A` in `A\nB` with blank-line separation produces `A\n\nX\n\nB`.

## Writes and failures

When Write changes or creates a file, it saves the file and finishes post-edit processing before returning, including in Codemode. If an existing file already matches the supplied content, Write returns its whole-file selection without writing or running post-edit handlers. Earlier pending edits commit before Write. Other eligible text edits keep their pending-batch behavior.

Independent calls share the original snapshots. Combine overlapping edits into one mutation. A rejected call does not cancel successful peers; retry only unapplied changes.

An omitted path can inherit the file identified by an anchor, the last read, or the preceding edit in the batch. Supply the path when that would be ambiguous.

An ordinary `delete.path` without selectors deletes a whole file, directory, or symlink. Directory and link deletion applies Git protection and may require a user dialog; no agent flag replaces approval. Links are unlinked without following their targets. A result input removes only selected text. Ordinary copy/move paths without selectors transfer whole regular files and replace an existing regular destination file.

Inside Codemode, await independent edits on disjoint resources concurrently and overlapping resources in order. Pass a pending edit result directly to another source tool for dependent work; that boundary commits the batch before consuming the result.

Failed tools reject in Codemode. Use try/catch or Promise.allSettled when independent calls may fail. Inspect the parent result for actual committed effects: an acceptance is not proof of writing, and an error is not proof of rollback. Read the affected files when the result cannot confirm their final state.

After an interruption, read the affected files before retrying. Retry only unapplied edits.

## Specialized resources

- `shell:<session>`: write sends exact input, insert sends keys, delete terminates the session.
- `debug:<session>`: insert controls the debugger; delete removes a breakpoint or terminates it.
- `symbol:<file>#<selector>#name`: replace performs a native language-server rename when available.

Read `docs:terminal`, `docs:debugger`, or `docs:search-code` before using these resources. Never guess after a stale snapshot, ambiguous target, incomplete selection, or unknown rollback effect.
