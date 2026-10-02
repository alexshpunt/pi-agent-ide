# Search, AST, and LSP workflow

## Text and path search

Use ordinary queries for literal text. If no literal result exists, unquoted input is tried as a regular expression and then ordinary multi-word input may be broadened to separate words. Quoted terms stay literal. Treat broadened results as location hints rather than safe edit selections.

Use uppercase `AND` and `OR`, infix `NOT`, `||`, or a space-separated `|` for Boolean queries. Parentheses group Boolean conditions. An unspaced `|`, regex groups, and character classes remain regular-expression syntax. Use `regex:<pattern>` to force regex matching.

Use `files:<pattern>` for paths. Slash-containing globs match workspace-relative paths; basename globs match at any depth. Narrow with `path`, `include`, and `exclude` before broadening a noisy query.

## Search resources

Inside native Codemode, check `status` and use `data.matches`, their exact `range`, and `references.line` or `references.match`. Use `data.all` only when returned. Check backend `complete` separately from public-window `truncated`; an empty successful match list is not an error.

Local text results expose `SEARCH#HASH:N:line` for its containing line and `SEARCH#HASH:N:match` for the exact match. Complete selections use `:all:line` or `:all:match`. Pass these references directly to read or editing tools; omit the file path when an all-selection spans files.

A single-result reference becomes stale after its file changes. Re-run the search before reuse. A complete `:all` reference refreshes its original query when selected files change. Compacted output retains complete all-selections.

## Searching returned scopes

Pass a source-aware Read/Search/replace/insert result, its `data`, a `RESULT#` reference, or an array of returned matches/resources as `path` to search their exact source ranges. Local text and `regex:` queries support this input. Sparse ranges and files stay separate; gaps and neighboring text are not searched.

A replace/insert result searches only that call's resulting text, including an empty resulting position. In native Codemode, passing a pending result commits the batch first. Final formatting runs at script end; targets from before changed formatting become stale, not silently rebound.

Pass `found.data.matches.filter(...)` to narrow a result with JavaScript. A whole result's `target` still selects its complete stored scope; changing its preview does not narrow it. Preserve returned target handles instead of reconstructing coordinates from text.

Check `complete` before treating zero matches as absence. Inherited incompleteness survives non-empty subsets. Empty arrays select no sources; they do not default to the workspace. Result-scoped Boolean queries, include/exclude globs, AST/symbol/file/process queries and other providers are unsupported at this stage and fail without widening the scope.

## AST search

Use `ast:<pattern>` for syntax-aware matching. `$NAME` captures one syntax node and `$$$BODY` captures several nodes. Returned search references can select multiline matches for read, replace, copy, move, delete, and Apply. An incomplete result does not provide a complete all-selection. Text replacement through an AST selection does not update imports or references automatically.

## Symbols and graphs

Use `symbols:<query>` to locate declarations and references when the source file is unknown. Use `symbol:<file>#<selector>` to read one declaration. Use `graph:<file>` for the file's top-level declarations and relationships, or `graph:<file>#<selector>` for incoming and outgoing references of one declaration.

Append `#name` to an exact symbol resource only for a native language-server rename across references. If semantic support is unavailable, use a precise text or AST operation instead of pretending it was a semantic rename. Pending or empty language-server output does not prove that no declaration or reference exists.

## Other search protocols

Use an HTTP(S) URL as `path` to search converted page text with a literal or `regex:` query. No prior Read is needed. Web results keep the requested URL and do not expose editable `SEARCH#` references. Use Read on that URL for more context.

Use `process:<query>` for running processes. Use `path: "shell:<session>"` to search retained terminal output beyond its current tail.
