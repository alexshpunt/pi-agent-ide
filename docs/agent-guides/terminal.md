# Terminal

- Write the syntax of the shell named in the tool's `command` field; don't infer it from the tool name or the OS.
- Run servers, watchers and long builds with `background: true`. A command that hits its timeout keeps running in the background.
- A returned or background session is not finished: check `status` and `exitCode` in its `shell:<session>` resource before treating it as done.
- Don't poll. When only waiting is left, end your turn: Pi wakes you when the session finishes, or with one notice after two minutes of silence. Then decide whether to keep waiting, send input or delete the session.
- Send input only while `status` is `running`: `write` for exact text, `insert` for keys such as `Enter` or `Ctrl+C`. `delete` ends the session.
- Use the `image` view when screen layout matters and `sequence` when changes over time matter.
- A failed command can still have done something. Check before retrying.
