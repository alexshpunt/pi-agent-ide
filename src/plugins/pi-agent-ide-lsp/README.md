# LSP plugin

This extension adds LSP diagnostics to normal filesystem reads, the `lsp_search` tool, and symbol targets for editing tools.

## lsp_search

Pass exactly one mode:

- `query`: workspace symbol search for declarations and references. `path` (file, directory or a returned result), `include` and `exclude` narrow it. `references: true` follows symbols found inside `path` to their references anywhere in the workspace.
- `declaration: "<path>#<selector>"`: the full LSP document-symbol range as a guarded `SEARCH#` selection. A selector uses `/` for nesting, for example `UserService/getUser`. A one-part selector finds a nested symbol only when that name is unique in the file; a multi-part selector must match the document-symbol hierarchy exactly.
- `calls: "<path>#<selector>"`: the definition, references grouped by file, incoming calls and outgoing calls. `calls: "<path>"` reports every top-level declaration in source order with the same relations and lists direct members with their `calls` values. When the server does not implement a call direction, such as outgoing calls in clangd 18, that section says so and the other relations are still reported.

`<path>` may be relative to the session directory or absolute. The tool runs its resolver through the shared Search execution core, so scopes, SSH owners and selections behave as in `search`; it is not registered as a `search` query form.

## Editing targets

`symbol:<path>#<selector>` is a path for `replace`, `copy`, `move` and `delete` without start/end. It edits only the declaration text; imports and references stay unchanged. `replace` on `symbol:<path>#<selector>#name` performs a native rename across references.

## Server lifecycle

A language server starts on the first request for a file it handles, such as post-edit diagnostics or `lsp_search`. Documents opened for a request close when it finishes, unless another request still uses them. A session that sends no requests for 10 minutes releases its server, and the next request starts or reconnects it. Change the timeout with the `lsp.idle-timeout` IDE setting, in minutes.

Pi sessions on one machine share a local server when they use the same server, command, configured environment, project root, initialization options and settings. The first session starts a background host process that runs the server; later sessions connect to it. Each session still sees its own document text, versions and diagnostics. The host keeps a document open on the server for 5 seconds after the last session closes it, so a request right after another one does not make the server analyze the file again. The host stops the server `lsp.idle-timeout` minutes after the last session disconnects, so a new session in that window gets a server that has already indexed the project. If a session cannot reach a shared server, it starts its own. Servers on SSH hosts are not shared; each session runs its own.

File watches that servers request cover only the project: patterns based on a parent directory see only files inside the project, and patterns based elsewhere are ignored. `.git` is not watched, and `node_modules` is watched only for packages added or removed.

## Failures

Malformed selectors, missing symbols, missing files and unavailable LSP servers return failed results. They never fall back to text search.

A server may cancel a request because a document changed while it worked (`ContentModified`) or because it dropped the request (`ServerCancelled`), as rust-analyzer does while several sessions edit. Such a request is sent again up to 5 times over about 1.5 seconds, unless the server says a retry will not help or the caller stops waiting. Only a request still cancelled after that fails with the server's message.

## Demo

Run the live TUI replay:

```bash
./scripts/interactive-demos/run-read-code-views-tui-loop.sh
```

The demo copies `src/code-view/reference.ts` into an isolated TypeScript project and shows the `ast:` outline and `lsp_search` declaration, symbol calls and file calls results in order.
