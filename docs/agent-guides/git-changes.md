# Git changes and undo workflow

Read a tracked file with `views: ["changes"]` to see staged and unstaged hunks and current `CHANGE#` anchors. Stage or unstage only the selected current change. Anchors are revision-sensitive, so re-read after index or worktree changes.

If an unstage anchor is stale, read the file again with `views: ["changes"]` and select a current change.

After a failed or interrupted unstage call, inspect the index with `git diff --cached -- <file>` before retrying. Do not assume the error means the index stayed unchanged.

Use a `CHANGE#` anchor to restore that selected Git change to `HEAD` in both worktree and index. Use `last` with a file only for that file's latest text-editor transaction. Inspect current changes before destructive restoration.

Undo applies the restore before returning, including in Codemode. Earlier pending edits commit before Undo runs. Formatting and registered post-edit handlers run at script end in Codemode; read the file again if they change its bytes.

`last` restores one saved transaction, not an undo history or redo. A successful restore clears that saved transaction.

After a failed or interrupted Git restore, read the file and inspect the index with `git diff --cached -- <file>` before retrying. Text restoration can succeed before an index update fails. Retry only the work that remains unapplied.
