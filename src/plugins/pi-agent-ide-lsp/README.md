# LSP plugin

This extension adds LSP diagnostics to normal filesystem reads, the `lsp_search` tool, and symbol targets for editing tools.

## lsp_search

Pass exactly one mode:

- `query`: workspace symbol search for declarations and references. `path` (file, directory or a returned result), `include` and `exclude` narrow it. `references: true` follows symbols found inside `path` to their references anywhere in the workspace.
- `declaration: "<path>#<selector>"`: the full LSP document-symbol range as a guarded `SEARCH#` selection. A selector uses `/` for nesting, for example `UserService/getUser`. A one-part selector finds a nested symbol only when that name is unique in the file; a multi-part selector must match the document-symbol hierarchy exactly.
- `calls: "<path>#<selector>"`: the definition, references grouped by file, incoming calls and outgoing calls. `calls: "<path>"` reports every top-level declaration in source order with the same relations and lists direct members with their `calls` values.

`<path>` may be relative to the session directory or absolute. The tool runs its resolver through the shared Search execution core, so scopes, SSH owners and selections behave as in `search`; it is not registered as a `search` query form.

## Editing targets

`symbol:<path>#<selector>` is a path for `replace`, `copy`, `move` and `delete` without start/end. It edits only the declaration text; imports and references stay unchanged. `replace` on `symbol:<path>#<selector>#name` performs a native rename across references.

## Failures

Malformed selectors, missing symbols, missing files and unavailable LSP servers return failed results. They never fall back to text search.

## Demo

Run the live TUI replay:

```bash
./scripts/interactive-demos/run-read-code-views-tui-loop.sh
```

The demo copies `src/code-view/reference.ts` into an isolated TypeScript project and shows the `ast:` outline and `lsp_search` declaration, symbol calls and file calls results in order.
