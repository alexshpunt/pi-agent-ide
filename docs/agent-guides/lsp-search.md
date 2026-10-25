# Language-server search with lsp_search

`lsp_search` asks the project's language servers about declarations, references and calls. Pass exactly one of `query`, `declaration` or `calls`. Use `search` for plain text and `ast_search` for syntax patterns.

## Find symbols

`query` finds declarations and references by symbol name. Without `path` it searches the workspace; with a file, directory or Read/Search/edit result it stays inside that scope. `include` and `exclude` narrow files.

Each match is a `SEARCH#...:N:match` selection with its role (`definition` or `reference`) and the declaration it belongs to. Equal names do not mean the same symbol; compare the declared-at location.

Set `references: true` to follow the symbols found inside `path` to their references anywhere in the workspace. `path` then defines the seed, not where results may appear.

```js
const window = await tools.read({ path: "src/app.ts", offset: 10, limit: 5 });
const uses = await tools.lsp_search({ path: window, query: "start", references: true });
```

## Read a declaration

`declaration` takes `file#selector`, such as `src/app.ts#App/start`. A selector names nested symbols with `/`; a one-part name must be unique in the file. The result is the exact declaration as a `SEARCH#` selection, so Read, Search, Copy, Move and Delete can use it directly.

## Calls and references

`calls` takes `file#selector` for one declaration, or `file` for every top-level declaration. It lists references grouped by file and incoming and outgoing calls. Member lines show the `calls` value to use next.

## Edit and rename

`symbol:<file>#<selector>` works as a path for `replace`, `copy`, `move` and `delete` without start/end; it edits only the declaration text and leaves imports and references unchanged. `replace` on `symbol:<file>#<selector>#name` with the new name performs a native language-server rename across references. A failed rename never falls back to text replacement.

## Limits

Unavailable or failed language servers are errors, not evidence of absence. An incomplete result proves nothing about absence. A single-match reference goes stale when its file changes; repeat the call.
