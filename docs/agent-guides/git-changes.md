# Git changes and undo workflow

Read a tracked file with `views: ["changes"]` to see staged and unstaged hunks and current `CHANGE#` anchors. Stage or unstage only the selected current change. Anchors are revision-sensitive, so re-read after index or worktree changes.

Use `undo` with an `APPLY#` receipt to restore every path from one Apply checkpoint atomically. Use a `CHANGE#` anchor to restore that selected Git change to `HEAD` in both worktree and index. Use `last` with a file only for that file's latest text-editor transaction. Inspect current changes before destructive restoration.
