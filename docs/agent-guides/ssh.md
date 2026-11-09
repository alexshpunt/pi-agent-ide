# SSH

## Set up a target

1. Read `.pi/pi-agent-ide/ssh.json` in the project and reuse a matching target. Create the file if it is missing, keeping other targets. Use the global `~/.pi/agent/pi-agent-ide/ssh.json` (or `$PI_CODING_AGENT_DIR/pi-agent-ide/ssh.json`) only when the user asks.
2. Take the host from the user's request and the OpenSSH config. Ask only for what you can't find, such as the remote workspace path. Keys, passwords and host keys stay in OpenSSH. Don't print credentials or turn off host-key checks; ask before changing authentication or trusting a new host key.
3. Check access with local bash: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 HOST 'pwd; python3 --version'` (add `-F <config>` for a custom config). For a native Windows host, run `py -3 --version` instead; the `python3` command there is often the Microsoft Store alias, not Python. The target needs Python 3. If this fails, fix SSH access first: a target record can't fix authentication.
4. Add a record with a short unique `id` (such as `vps`), the OpenSSH `host` alias (optionally `user@alias`) and an absolute `workspace`. For a native Windows host, add `"os": "windows"` and give the workspace with its drive, such as `C:/Users/name`; Linux is the default. A host reached through WSL is a Linux target. Optional `configFile` points to an OpenSSH config, relative to `ssh.json`.
5. Reload Pi extensions (the reload tool, or ask the user for `/reload`). Then read `docs:ssh` again to see the configured workspaces.
6. Verify with `read` on the `ssh://` workspace. Also run a command with that SSH `cwd`: `hostname; pwd` with `bash` on a Linux target, or `hostname` with `remote_powershell` on a Windows target. A plain `ssh` command succeeding does not prove IDE access.

```json
{
  "targets": [
    { "id": "vps", "host": "vps", "workspace": "/root" },
    { "id": "win", "host": "win", "workspace": "C:/Users/name", "os": "windows" }
  ]
}
```

Keep machine-specific targets out of shared Git history unless the user asks.

## Windows targets

- Name Windows files with their drive: `ssh://win/C:/Users/name/file.txt`. Relative paths may use `\` or `/`.
- Windows targets support `read`, `raw:` and directory listings, and terminal sessions through `remote_powershell`. Other operations on a Windows target report `CAPABILITY_UNAVAILABLE`.
- `remote_powershell` runs Windows PowerShell in a terminal session with resize, control keys such as Ctrl+C, background sessions and `shell:` references. Stopping a session ends everything it started.
- `search` and `file_search` need ripgrep (`rg`) and `ast_search` needs `ast-grep` on the target's PATH for SSH sessions; for example `winget install BurntSushi.ripgrep.MSVC` and `npm install --global @ast-grep/cli`. A missing tool is reported by name with this hint. An npm `.cmd` shim works.
- The `changes` view, `stage` and `unstage` use the target's Git. With `core.autocrlf` or an `eol` attribute, a CRLF file is compared to Git's LF blobs. `undo` with a `CHANGE#` anchor rewrites the file, so it needs file writes on the target; it restores CRLF only in a file that is uniformly CRLF.

## Work on a target

- Use the ordinary tools with `ssh://<target>/<absolute path>`: read, write and edit tools, search, file_search, ast_search, lsp_search, copy, move, delete, undo. Copy and move also work between local and remote paths.
- Run commands with an SSH `cwd`: `bash` for Linux targets and `remote_powershell` for Windows targets. On a Windows host, `powershell` runs on Windows targets and `remote_bash` on Linux targets. `remote_powershell` and `remote_bash` appear only when a target of that OS is configured and need an `ssh://` `cwd`. Debug with `debug` and an SSH `cwd`. Read `docs:terminal` or `docs:debugger` first.
- `raw:ssh://…` reads original bytes. `web:ssh://<target>/https://…` fetches a page from the target; plain URLs are still fetched locally.
- The workspace is only the base for relative paths, not a sandbox.
- The target needs its own tools: Git for `changes` and `undo`, `ast-grep` for ast_search, the language servers for lsp_search, and Node, `playwright-core` and Chromium for rendered web pages. Nothing is installed automatically.
- Operations across two machines are not atomic. After a failure, check both sides before retrying; don't replay a write whose effect is unknown.
- `/agent-ide-doctor ssh://<target>/<path>` checks that project's setup on the target.
