# SSH

## Set up a target

1. Read `.pi/pi-agent-ide/ssh.json` in the project and reuse a matching target. Create the file if it is missing, keeping other targets. Use the global `~/.pi/agent/pi-agent-ide/ssh.json` (or `$PI_CODING_AGENT_DIR/pi-agent-ide/ssh.json`) only when the user asks.
2. Take the host from the user's request and the OpenSSH config. Ask only for what you can't find, such as the remote workspace path. Keys, passwords and host keys stay in OpenSSH. Don't print credentials or turn off host-key checks; ask before changing authentication or trusting a new host key.
3. Check access with local bash: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 HOST 'pwd; python3 --version'` (add `-F <config>` for a custom config). The target needs Python 3. If this fails, fix SSH access first: a target record can't fix authentication.
4. Add a record with a short unique `id` (such as `vps`), the OpenSSH `host` alias (optionally `user@alias`) and an absolute Linux `workspace`. Optional `configFile` points to an OpenSSH config, relative to `ssh.json`.
5. Reload Pi extensions (the reload tool, or ask the user for `/reload`). Then read `docs:ssh` again to see the configured workspaces.
6. Verify with `read` on the `ssh://` workspace and `bash` with that SSH `cwd`, for example `hostname; pwd`. A plain `ssh` command succeeding does not prove IDE access.

```json
{ "targets": [{ "id": "vps", "host": "vps", "workspace": "/root" }] }
```

Keep machine-specific targets out of shared Git history unless the user asks.

## Work on a target

- Use the ordinary tools with `ssh://<target>/<absolute path>`: read, write and edit tools, search, file_search, ast_search, lsp_search, copy, move, delete, undo. Copy and move also work between local and remote paths.
- Run commands with `bash` and an SSH `cwd`; debug with `debug` and an SSH `cwd`. Read `docs:terminal` or `docs:debugger` first.
- `raw:ssh://…` reads original bytes. `web:ssh://<target>/https://…` fetches a page from the target; plain URLs are still fetched locally.
- The workspace is only the base for relative paths, not a sandbox.
- The target needs its own tools: Git for `changes` and `undo`, `ast-grep` for ast_search, the language servers for lsp_search, and Node, `playwright-core` and Chromium for rendered web pages. Nothing is installed automatically.
- Operations across two machines are not atomic. After a failure, check both sides before retrying; don't replay a write whose effect is unknown.
- `/agent-ide-doctor ssh://<target>/<path>` checks that project's setup on the target.
