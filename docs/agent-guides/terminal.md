# Terminal and process workflow

Use the registered shell tool (`bash` or `powershell`) for project commands. Check its command parameter for the actual shell and write that shell's syntax; do not infer syntax from the tool name or operating system. Keep short commands in the foreground. Start servers, watchers, and long builds with `background: true`; continue other work rather than polling. Read the returned `shell:<session>` resource for status and bounded output. Search that resource to locate retained output outside the current tail.

Check `status` and `exitCode` before treating a process as successfully completed. A returned background session or a released foreground wait is not a completion report. A timeout, detected input prompt, or turn interruption releases the wait without stopping a live process. Read the same `shell:` source to continue; it also survives extension reloads.

Send input only when `status` is `running`. Do not treat `stopping`, `stopped`, or `cancelled` as a preserved interactive wait. Before retrying a failed or interrupted command, inspect any returned session. If no source was returned, use `process:<query>` search to check for a process that may have started. Failure does not undo command side effects.

Use the log path in a truncation notice to inspect omitted output.

Use `write` on a shell resource to send exact text without Enter. Use `insert` for named keys and chords such as `Enter`, `Ctrl+C`, or `Up`. Delete a shell resource to terminate and remove the session. Add the `image` view only when cursor position, ANSI layout, or a full-screen interface matters. Use a bounded `sequence:duration=<seconds>,interval=<seconds>,scale=<ratio>` view when changes over time matter.

Use `process:<query>` search before reading `process:<PID>` or capturing `window:<PID>`.

If a session returns as running in background and no independent work remains, finish your turn instead of polling. Pi wakes the agent when the session completes. A still-running session also gets one inspection notice after two minutes without terminal activity, once the agent is idle. Read the session when that notice arrives and decide whether to keep waiting, send input, or delete it. An inspection notice is not proof of failure or completion.
