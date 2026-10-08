# Search, AST, and LSP workflow

## Text and path search

Use ordinary queries for literal text. If no literal result exists, unquoted input is tried as a regular expression and then ordinary multi-word input may be broadened to separate words. Quoted terms stay literal. Treat broadened results as location hints rather than safe edit selections.

Use uppercase `AND` and `OR`, infix `NOT`, `||`, or a space-separated `|` for Boolean queries. Parentheses group Boolean conditions. An unspaced `|`, regex groups, and character classes remain regular-expression syntax. Use `regex:<pattern>` to force regex matching.

Use `files:<pattern>` for paths. Slash-containing globs match workspace-relative paths; basename globs match at any depth. Narrow with `path`, `include`, and `exclude` before broadening a noisy query.

## Search resources

Inside native Codemode, check `status` and use `data.matches`, their exact `range`, and `references.line` or `references.match`. Use `data.all` only when returned. Check backend `complete` separately from public-window `truncated`; an empty successful match list is not an error.

Use verified Read/Search/Select results, their `data`, returned items, or `RESULT#` targets as Search scopes. These inputs keep exact source ranges and sparse gaps. Reconstructed coordinates do not grant access. Refresh stale snapshots before searching again.

Use `navigation: "references"` only for symbol searches that must follow declarations outside the input scope. Without navigation, symbol results stay inside the supplied ranges. Reference results retain the originating declaration identity; equal names do not establish that identity.
Local text results expose `SEARCH#HASH:N:line` for its containing line and `SEARCH#HASH:N:match` for the exact match. Complete selections use `:all:line` or `:all:match`. Pass these references directly to read or editing tools; omit the file path when an all-selection spans files.

A single-result reference becomes stale after its file changes. Re-run the search before reuse. A complete `:all` reference refreshes its original query when selected files change. Compacted output retains complete all-selections.

## AST search

Use `ast:<pattern>` for syntax-aware matching. `$NAME` captures one syntax node and `$$$BODY` captures several nodes. Returned search references can select multiline matches for read, replace, copy, move, delete, and Apply. An incomplete result does not provide a complete all-selection. Text replacement through an AST selection does not update imports or references automatically.

## Symbols and graphs

Use `symbols:<query>` to locate declarations and references when the source file is unknown. Use `symbol:<file>#<selector>` to read one declaration. Use `graph:<file>` for the file's top-level declarations and relationships, or `graph:<file>#<selector>` for incoming and outgoing references of one declaration.

Append `#name` to an exact symbol resource only for a native language-server rename across references. If semantic support is unavailable, use a precise text or AST operation instead of pretending it was a semantic rename. Pending or empty language-server output does not prove that no declaration or reference exists.

## Other search protocols

Use an HTTP(S) URL as `path` for local web execution, or `web:ssh://target/https://example.com/page` for explicit target execution. Search converted page text with a literal or `regex:` query; no prior Read is needed. Web results keep the requested source and do not expose editable `SEARCH#` references. Use Read on that source for more context.

Use `process:<query>` for running processes. Use `path: "shell:<session>"` to search retained terminal output beyond its current tail.
