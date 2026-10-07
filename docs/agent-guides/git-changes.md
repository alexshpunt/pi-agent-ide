# Git changes and undo workflow

Read a tracked file with `views: ["changes"]` to see staged and unstaged hunks and current `CHANGE#` anchors. Stage or unstage only the selected current change. Anchors are revision-sensitive, so re-read after index or worktree changes.

If an unstage anchor is stale, read the file again with `views: ["changes"]` and select a current change.

After a failed or interrupted unstage call, inspect the index with `git diff --cached -- <file>` before retrying. Do not assume the error means the index stayed unchanged.

Use a `CHANGE#` anchor to restore that selected Git change to `HEAD` in both worktree and index. Use `last` with a file only for that file's latest text-editor transaction. Inspect current changes before destructive restoration.
