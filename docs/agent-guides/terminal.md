# Terminal and process workflow

Use `bash` for project commands. Keep short commands in the foreground. Start servers, watchers, and long builds with `background: true`; continue other work rather than polling. Read the returned `shell:<session>` resource for status and bounded output. Search that resource to locate retained output outside the current tail.

Use `write` on a shell resource to send exact text without Enter. Use `insert` for named keys and chords such as `Enter`, `Ctrl+C`, or `Up`. Delete a shell resource to terminate and remove the session. Add the `image` view only when cursor position, ANSI layout, or a full-screen interface matters. Use a bounded `sequence:duration=<seconds>,interval=<seconds>,scale=<ratio>` view when changes over time matter.

Use `process:<query>` search before reading `process:<PID>` or capturing `window:<PID>`. Do not assume silent background work has completed.
