# LSP read views

This extension adds LSP diagnostics to normal filesystem reads and owns two semantic `read` sources.

```text
symbol:<path>#<selector>
graph:<path>
graph:<path>#<selector>
```

`<path>` is required. It may be relative to the session directory or absolute. A selector uses `/` for nesting, for example `UserService/getUser`.

## Symbol body

`symbol:<path>#<selector>` reads the full LSP document-symbol range. The result contains the original source lines and line hashes. A one-part selector may find a nested symbol only when that name is unique in the file. A multi-part selector must match the document-symbol hierarchy exactly.

## Symbol graph

`graph:<path>#<selector>` returns the definition, references grouped by file, incoming calls, and outgoing calls. Locations use line hashes when the target is a local file. Long groups report how many files or locations were omitted.

## File graph

`graph:<path>` reports every top-level declaration in source order. Each declaration includes its definition, files that reference it, incoming calls, and outgoing calls. Direct members are listed with ready `graph:` selectors, but the extension does not run a separate graph query for each member.

## Failures

Malformed sources, missing symbols, missing files, and unavailable LSP servers return failed `read` results. A claimed `symbol:` or `graph:` source never falls back to the filesystem resolver.

## Demo

Run the live TUI replay:

```bash
./scripts/interactive-demos/run-read-code-views-tui-loop.sh
```

The demo copies `src/code-view/reference.ts` into an isolated TypeScript project and shows `ast:`, `symbol:`, symbol `graph:`, and file `graph:` results in order.
