# Editing

## Select text

- `LINE#HASH` from `read` with `views: ["anchors"]` selects a line. `scope-begin-HASH` / `scope-end-HASH` from the `ast` view select a syntax block. `SEARCH#…:line` selects a search match's line, `SEARCH#…:match` the match itself. `begin` and `end` select the first and last line.
- Without an anchor, use the shortest unique exact text.
- With `start` and `end`, the selection runs from the start of `start` to the end of `end`. Exact text keeps character boundaries; line anchors take whole lines.
- After an exact-text selector fails, exact text is blocked for that file until an anchor-based edit succeeds. Use one of the anchors the error returns; don't guess another string.
- Anchors and results go stale when their file changes. Read or search again before reusing them.

## Pass results between tools

Pass a result unchanged as `path` (outside Codemode its UUID also works). It selects exactly what it returned:

- read: its window; search: its matches;
- replace and insert: the new text; copy and move: the destination text;
- write and undo: the whole file; delete: nothing.

In Codemode, `search` returns `{ result, hasMatches, complete }`: pass `result` on. `hasMatches: false` proves absence only when `complete` is `true`. A failed read resolves to `{ status: "error", errors }` instead of rejecting. An image read returns an image block; pass it to `write` as `content` to save it.

## Batches and Codemode

- Parallel calls in one response all see the files as they were before the batch. Put overlapping changes into one call.
- A rejected call doesn't cancel the others. Retry only what failed.
- In Codemode, await edits on different files concurrently and on the same file in order. Failed tools reject: use `Promise.allSettled` when calls may fail.
- An error is not proof that nothing was written. After a failure or interruption, read the file before retrying.

## Files and directories

- `delete`, `copy` and `move` with a plain path and no `start` act on the whole file, directory or symlink. Symlinks are handled as links, never followed.
- Copying a directory merges into the target; moving one replaces the target. Recursive transfers have no rollback.
- Deleting a directory or symlink can ask the user for confirmation; read `docs:ide-settings` if they want to change that.

## Blank lines

`insert` with `separation: "blank-line"` puts the text in its own paragraph: inserting `X` after `A` in `A\nB` gives `A\n\nX\n\nB`.

## Live resources

`shell:`, `debug:` and `symbol:` paths: read `docs:terminal` or `docs:debugger`; `symbol:` is described in the `path` field of the edit tools.
