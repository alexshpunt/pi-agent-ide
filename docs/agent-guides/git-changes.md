# Git changes

- Read a tracked file with `views: ["changes"]` to see its staged and unstaged hunks as `CHANGE#` anchors. Anchors go stale when the file or index changes; read again.
- Stage or unstage one change by its anchor. `undo` with a `CHANGE#` anchor reverts that change in worktree and index; `undo` with `last` reverts the last tool edit of a file, once.
- `undo` with `last` restores the saved text only if the file still matches the result of that edit. If another writer changed the file, `undo` refuses rather than overwriting it. Read the current file before deciding what to revert.
- After a failed or interrupted stage, unstage or undo, read the file and check `git diff --cached -- <file>` before retrying: the worktree can change before the index update fails.
