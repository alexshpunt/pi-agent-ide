# SSH resources

Use the existing read and text-editing tools with `ssh://target/absolute/path`. Select a target from the configured workspaces below. Unknown targets fail without falling back to local files. The workspace is a relative-path base, not a sandbox; absolute paths use the remote account's permissions.

Use `raw:ssh://target/absolute/path` to read original bytes with `offset` and `limit`. Raw reads do not convert content or accept views. Text snapshots have a 32 MiB transport limit; raw reads fetch bounded chunks instead. Separate byte windows are not an immutable snapshot.

Use `search` with an SSH `path` for text, `regex:` and `files:` queries. Ripgrep runs on that target; include/exclude globs, Boolean queries and fallback rules stay the same. Results use canonical SSH paths. `SEARCH#` selections keep their owning backend for stale checks, complete-selection refresh and observation after editing. Remote text snapshots for anchors have the same 32 MiB limit.

Use `search` with `ast:<pattern>` and an SSH `path` for structural matches. It needs `ast-grep` on that target. Returned `SEARCH#` ranges use the same owned snapshots and refresh rules as text search. Use `read` with `ast:ssh://target/path` for a compact outline, or `views: ["ast"]` for scope anchors on source text. These presentations parse the fetched snapshot locally; they do not read a local copy of the remote path. Explicit outlines keep the existing 256 KiB source limit.

Use `read` with `views: ["changes"]` on a tracked SSH file to get `CHANGE#` anchors. Use `stage` and `unstage` with that file and anchor to change its remote index; the worktree is kept. Use `undo` with a `CHANGE#` anchor to restore that change in worktree and index. Git must be installed on the target. Index publication holds Git’s index lock and checks HEAD, the index entry and expected worktree text before publishing. Worktree and index restoration are not one atomic operation; inspect both after a failure or an unknown effect.

Use whole-file `copy`, `move` and `delete` with SSH paths. Copies and moves also support local/SSH and target/target transfers, streaming original bytes without text conversion. Use regular files; symbolic links are rejected. Use `overwrite: true` to replace an existing regular target. Missing destination parents are created after endpoint checks. Undo restores file entries, not newly created parent directories. Same-target, same-filesystem moves keep the inode. Other moves publish the destination before removing the source and can have a partial effect on interruption.

Use the standalone editing tools with writable SSH text resources and mixed local/SSH files. Use Codemode to compose those tools; Apply and Flush are not available. Check each operation's reported effect. Use `undo` with `last` for a saved text-editor transaction or a `CHANGE#` anchor for a Git change. Cross-backend writes and compensation are not distributed atomic operations.

Use `bash` with an SSH `cwd` to run Bash in the remote account's environment. Use the returned `shell:` resource for input, output and cleanup. Read `docs:terminal` before interacting with a session. Remote process IDs belong to the named target, not the local machine.

Use `search` with `process:<query>` and an SSH `path` for process discovery on a configured Linux target. Use each returned `process:ssh://target/PID` resource for metadata. Its kernel identity combines the target boot ID and native start ticks; discovery does not grant process control or controller window capture. Keep target PIDs separate from local PIDs. A missing native process facility fails without controller fallback.

Use `debug` with an SSH `cwd` for a target-owned debugger session. Read `docs:debugger` before setting anchored breakpoints or starting the program. Adapter source paths map to canonical SSH resources; document text and evaluation values are not rewritten. A missing or unsupported native adapter fails without controller fallback. Delete the session resource to stop its owned transport.

Use `read` or `search` with `web:ssh://target/https://example.com/page` for explicit target HTTP/browser execution. Ordinary HTTP(S) URLs still execute locally, regardless of the current SSH workspace. The target uses its own DNS and proxy environment. Read tries direct HTTP first, then rendered browser content when needed; web text has no editable file anchors. Image and PDF conversion uses the fetched bytes and existing local converters.

Use `image` or `sequence` views on the explicit web source for target browser screenshots, with the existing region, scale and grid parameters. Browser fallback and capture require Node, `playwright-core` and Chrome/Chromium on the target. They use a fresh temporary profile, enable page JavaScript and disable the Chromium sandbox, matching ordinary browser reads. Missing dependencies fail without launching a controller browser. No dependency is installed automatically. Capture is limited to 16 million pixels and 20 MiB of PNG per frame; requests have a 30-second deadline and cancellation waits for owned cleanup.

Use `/pi-agent-ide-doctor ssh://target/path` to inspect an explicitly selected target project. Target-sensitive checks use its native tools and project/user-global config; pure-content checks stay on the controller. Use `--no-apply` to inspect without suggested writes. `--apply` publishes suggested mappings only in that project's `.pi/pi-agent-ide/`, preserving existing entries. Agent setup and its recheck retain that same target. Ordinary startup tips remain local; an unused target is not probed.

Read the current source before editing it. A stale snapshot fails without overwriting the changed file. Check the reported effect after interrupted writes; do not replay a write whose effect is unknown. IDE writes are serialized, but external writers can still race the final check.

Do not assume that choosing an SSH resource routes every other IDE provider remotely. Check each provider's supported sources and errors before using it.
