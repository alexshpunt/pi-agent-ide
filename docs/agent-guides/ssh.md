# SSH resources

## Set up a target

When the user asks to connect to or work on a remote device or environment over SSH, set up a target before using remote resources. Use the existing tools; no separate SSH tool is needed.

1. Read the current project's `.pi/pi-agent-ide/ssh.json` and reuse a matching target. If the file is missing, create it. Preserve unrelated targets and settings. Use project settings by default; use global settings only when the user explicitly asks. The global file is `~/.pi/agent/pi-agent-ide/ssh.json`, or `$PI_CODING_AGENT_DIR/pi-agent-ide/ssh.json` when that variable is set.
2. Resolve the host from the user's request and existing OpenSSH configuration. Ask only for missing connection details or the remote workspace path when they cannot be established from the request or existing configuration. Keep keys, passwords and host-key trust in OpenSSH, not in IDE settings. Do not print credentials or disable host-key checks. Ask before changing authentication or trusting a new host key.
3. Check access with local Bash: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 HOST 'pwd; python3 --version'`. Add `-F /path/to/config` when using a custom OpenSSH config. Require Python 3 on the target. Inspect a failed connection before editing IDE settings; a target record cannot fix missing authentication or host trust.
4. Add a target record with a unique `id`, a trusted OpenSSH `host` alias (optionally `user@alias`), and an absolute Linux `workspace` path. Use an existing workspace unless the task needs a new one. Use a short stable ID, such as `vps`. Optional `configFile` selects a local OpenSSH config; relative paths resolve beside `ssh.json`.
5. Reload Pi extensions after adding or changing a target. Use the reload tool when available, or ask the user to run `/reload`. Reload can reset extension state; finish or stop owned live sessions first. Read `docs:ssh` again after reload to see the configured workspaces.
6. Verify the target with `read` on its `ssh://` workspace and `bash` with that SSH `cwd`, for example `hostname; pwd`. Report the actual tool results. Do not claim remote IDE access from a successful plain SSH command alone.

Example project `.pi/pi-agent-ide/ssh.json`:

```json
{
  "targets": [{ "id": "vps", "host": "vps", "workspace": "/root" }]
}
```

Project records replace complete global records with the same ID. Duplicate IDs in one file, unknown fields and invalid records fail startup. Keep machine-specific target settings out of shared Git history unless the user asks to share them.

## Use remote resources

Use the existing read and text-editing tools with `ssh://target/absolute/path`. Select a target from the configured workspaces below. Unknown targets fail without falling back to local files. The workspace is a relative-path base, not a sandbox; absolute paths use the remote account's permissions.

Use `raw:ssh://target/absolute/path` to read original bytes with `offset` and `limit`. Raw reads do not convert content or accept views. Text snapshots have a 32 MiB transport limit; raw reads fetch bounded chunks instead. Separate byte windows are not an immutable snapshot.

Use `search` with an SSH `path` for text, `regex:` and `files:` queries. Ripgrep runs on that target; include/exclude globs, Boolean queries and fallback rules stay the same. Results use canonical SSH paths. `SEARCH#` selections keep their owning backend for stale checks, complete-selection refresh and observation after editing. Remote text snapshots for anchors have the same 32 MiB limit.

Use `search` with `ast:<pattern>` and an SSH `path` for structural matches. It needs `ast-grep` on that target. Returned `SEARCH#` ranges use the same owned snapshots and refresh rules as text search. Use `read` with `ast:ssh://target/path` for a compact outline, or `views: ["ast"]` for scope anchors on source text. These presentations parse the fetched snapshot locally; they do not read a local copy of the remote path. Explicit outlines keep the existing 256 KiB source limit.

Use `read` with `views: ["changes"]` on a tracked SSH file to get `CHANGE#` anchors. Use `stage` and `unstage` with that file and anchor to change its remote index; the worktree is kept. Use `undo` with a `CHANGE#` anchor to restore that change in worktree and index. Git must be installed on the target. Index publication holds Git’s index lock and checks HEAD, the index entry and expected worktree text before publishing. Worktree and index restoration are not one atomic operation; inspect both after a failure or an unknown effect.

Use whole-object `copy` and `move` with SSH paths, including local/SSH and target/target transfers. Regular files keep their original bytes; directory trees and source links are supported too. Copy merges compatible directories; Move replaces a compatible destination after removal checks. Destination symlinks, mismatched types, same-object transfers and overlapping trees are refused. Link bytes are preserved without following their targets. Directory and link receipts have no reusable text selection. Missing destination parents are created after endpoint checks. Directory/link Move checks both owners' Git protection, hooks and required user dialogs, then rechecks both trees after approval. Same-target, same-filesystem moves keep the inode. Other moves publish the destination before rechecking and removing the source. Partial copies and interrupted moves have no rollback and can leave unknown effects.

Whole-object `delete` also supports SSH directories and symlinks, including broken links. Directories are removed recursively; links are unlinked without following their targets. The safety check uses the selected target's Git worktree, never the controller's Git state. Hooks and user dialogs name canonical SSH paths. Tracked or staged directories and links and failed Git checks inside the project require a user dialog. External targets and missing Git worktrees require a dialog unless a temporary-directory exception applies. An unavailable required dialog blocks removal. Project roots, ancestors, filesystem roots, and Git control paths are always protected. The target identity and policy are checked again after approval. Changed targets need a new request. Recursive deletion has no rollback; a failure after removal starts can leave unknown effects.

Temporary-directory exceptions use the selected SSH account's home, system temp and `PI_CODING_AGENT_DIR`, plus that project's `.pi/pi-agent-ide/deletion.json`. Controller settings never grant remote permission. Only descendants of configured temporary roots qualify; the roots themselves stay guarded. Git-tracked entries, failed Git checks inside the project, protected paths, and hooks still block or require approval. Delete reloads the target settings during its final safety check. Move does not use temporary exceptions.

Use the standalone editing tools with writable SSH text resources and mixed local/SSH files. Use Codemode to compose those tools; Apply and Flush are not available. Check each operation's reported effect. Use `undo` with `last` for a saved text-editor transaction or a `CHANGE#` anchor for a Git change. Cross-backend writes and compensation are not distributed atomic operations.

Use `bash` with an SSH `cwd` to run Bash in the remote account's environment. Use the returned `shell:` resource for input, output and cleanup. Read `docs:terminal` before interacting with a session. Remote process IDs belong to the named target, not the local machine.

Use `search` with `process:<query>` and an SSH `path` for process discovery on a configured Linux target. Use each returned `process:ssh://target/PID` resource for metadata. Its kernel identity combines the target boot ID and native start ticks; discovery does not grant process control or controller window capture. Keep target PIDs separate from local PIDs. A missing native process facility fails without controller fallback.

Use `debug` with an SSH `cwd` for a target-owned debugger session. Read `docs:debugger` before setting anchored breakpoints or starting the program. Adapter source paths map to canonical SSH resources; document text and evaluation values are not rewritten. A missing or unsupported native adapter fails without controller fallback. Delete the session resource to stop its owned transport.

Use `read` or `search` with `web:ssh://target/https://example.com/page` for explicit target HTTP/browser execution. Ordinary HTTP(S) URLs still execute locally, regardless of the current SSH workspace. The target uses its own DNS and proxy environment. Read tries direct HTTP first, then rendered browser content when needed; web text has no editable file anchors. Image and PDF conversion uses the fetched bytes and existing local converters.

Use `image` or `sequence` views on the explicit web source for target browser screenshots, with the existing region, scale and grid parameters. Browser fallback and capture require Node, `playwright-core` and Chrome/Chromium on the target. They use a fresh temporary profile, enable page JavaScript and disable the Chromium sandbox, matching ordinary browser reads. Missing dependencies fail without launching a controller browser. No dependency is installed automatically. Capture is limited to 16 million pixels and 20 MiB of PNG per frame; requests have a 30-second deadline and cancellation waits for owned cleanup.

Use `/pi-agent-ide-doctor ssh://target/path` to inspect an explicitly selected target project. Target-sensitive checks use its native tools and project/user-global config; pure-content checks stay on the controller. Use `--no-apply` to inspect without suggested writes. `--apply` publishes suggested mappings only in that project's `.pi/pi-agent-ide/`, preserving existing entries. Agent setup and its recheck retain that same target. Ordinary startup tips remain local; an unused target is not probed.

Read the current source before editing it. A stale snapshot fails without overwriting the changed file. Check the reported effect after interrupted writes; do not replay a write whose effect is unknown. IDE writes are serialized, but external writers can still race the final check.

Do not assume that choosing an SSH resource routes every other IDE provider remotely. Check each provider's supported sources and errors before using it.
