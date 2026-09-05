# IDE changes extension

This extension gives the agent one stable `CHANGE#...` anchor for each current Git change in a tracked text file.

`read` compares the worktree file with `HEAD` and displays every change as a complete diff hunk. The anchor stays the same when the Git index changes. Its annotation shows whether the change is `unstaged`, `partial`, or `staged`.

`stage({ file, change: "CHANGE#..." })` puts only the selected change in the Git index. `unstage({ file, change: "CHANGE#..." })` removes only that change from the index. Neither tool changes the worktree file.

`undo({ file, change: "CHANGE#..." })` restores the selected change to its `HEAD` text. If any part of that change is staged, undo also removes it from the index. `undo({ file, change: "last" })` treats `last` as a command literal, not an anchor, and restores the file to its state before the latest text editor invocation that changed it.

A direct mutation call is one transaction. A coalesced text batch is also one transaction, but its state is stored independently for each changed file. The extension keeps only one transaction per file in memory. A newer edit replaces it, any restore consumes it, and an external change makes it stale. Newly created files are not stored.

Undo writes through the normal text editor pipeline. It keeps path inheritance, batching, post-edit processing, the final reread, overwrite protection for ordinary edits, and the standard mutation diff.

The extension supports tracked, non-conflicted text files in a Git worktree with an existing `HEAD`. It has no redo, stack, journal, disk cache, or session reconstruction. It is part of the default `pi-agent-ide` extension list.
