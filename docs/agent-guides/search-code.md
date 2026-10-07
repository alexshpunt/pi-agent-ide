# Search, AST, and LSP workflow

## Text and path search

Use ordinary queries for literal text. If no literal result exists, unquoted input is tried as a regular expression and then ordinary multi-word input may be broadened to separate words. Quoted terms stay literal. Treat broadened results as location hints rather than safe edit selections.

Use uppercase `AND` and `OR`, infix `NOT`, `||`, or a space-separated `|` for Boolean queries. Parentheses group Boolean conditions. An unspaced `|`, regex groups, and character classes remain regular-expression syntax. Use `regex:<pattern>` to force regex matching.

Use `files:<pattern>` for paths. Slash-containing globs match workspace-relative paths; basename globs match at any depth. Narrow with `path`, `include`, and `exclude` before broadening a noisy query.

## Possible names after zero matches

Use possible-name groups as spelling hints, not synonyms or proof of equivalent behavior. Inspect the candidate source before choosing an edit. The original match list stays empty; each group is a separate exact alternative in the same scope.

Inspect the displayed possible-name groups and their completeness separately. The whole Search result still selects the original empty match set, not a suggested alternative. Use the chosen group's returned references to inspect or edit that alternative. A candidate all-reference refreshes only its exact alternative, not the fuzzy ranking. For URL groups, read the returned URL and line range; no editable Search references exist. Result-scoped queries stay exact and do not run this extra branch.

If the extra branch reports a budget skip, narrow `path` rather than treating the skip as proof that no nearby name exists. Keep quoted exact queries, Boolean queries, and explicit protocols exact.

## Search resources

Search returns readable matches and references in direct calls and Codemode. An empty successful search is not an error. Incomplete results say so; do not treat their zero matches as proof of absence.

If Search fails, fix the reported input, scope or provider problem before retrying. Keep the intended search scope; do not treat the failure as zero matches.

If Search is interrupted or cancelled, do not treat it as zero matches or completed coverage. Do not use its unfinished result as an edit scope. Retry only when the search is still wanted, and use the new result.

If a result has no local edit references, use its locations to inspect the source, not as an edit scope. For changed local files, repeat Search or Read to obtain a current selection before editing.

Local text results expose `SEARCH#HASH:N:line` for its containing line and `SEARCH#HASH:N:match` for the exact match. Complete selections use `:all:line` or `:all:match`. Pass these references directly to read or editing tools; omit the file path when an all-selection spans files.

A single-result reference becomes stale after its file changes. Re-run the search before reuse. A complete `:all` reference refreshes its original query when selected files change. Compacted output retains complete all-selections.

## Searching returned scopes

Pass an unchanged Read/Search/Select/edit result, its UUID or a `RESULT#` reference as `path`. Arrays of registered results also work. Local text, `regex:`, `ast:`, and `symbols:` queries search their exact ranges. Sparse ranges and files stay separate; gaps and neighboring text are not searched.

A replace/insert result searches only that call's resulting text, including an empty resulting position. Copy/move search only destination text; whole-file transfers, write and undo search whole resulting files. Delete and restored absence have no live text target. In Codemode, passing a pending result commits the batch first. Final formatting runs at script end; results from before changed formatting become stale, not silently rebound.

Use a displayed item or capture reference for a subset. The whole result retains its complete stored scope; editing copied preview text never narrows that scope.

Incomplete registered result scopes cannot authorize edits, even through non-empty subsets. A numbered local text Search reference remains editable while its file snapshot is current, even if collection was incomplete. Use it only for its containing line or exact match, not as a complete match set. Empty arrays select no sources; they do not default to the workspace. Result-scoped text Boolean queries and text include/exclude globs remain unsupported. AST and LSP providers retain their own path/glob filters. File/process and unsupported provider scopes fail without widening the scope.

## AST search

Use `ast:<pattern>` for syntax-aware matching. `$NAME` captures one syntax node and `$$$BODY` captures several nodes. Returned search references can select multiline matches for read, replace, copy, move, and delete. An incomplete result does not provide a complete all-selection. Text replacement through an AST selection does not update imports or references automatically.

Use the displayed `capture NAME: RESULT#...` reference to Search or edit a capture without Select. It belongs to that parent match and retains every captured node, including punctuation. Its node count does not change the selection. An empty capture selects nothing; an absent capture has no reference. AST matches and captures must be wholly contained in one requested region; they are not clipped at a scope boundary.

```js
const window = await tools.read({ path: "client.ts", offset: 10, limit: 4 });
const calls = await tools.search({ path: window, query: "ast:request($OPTIONS)" });
text(calls);
```

Use its displayed OPTIONS reference in the next call. Store/load keeps these result strings across Codemode scripts within the same session.

## Symbols and graphs

Use `symbols:<query>` to locate declarations and references when the source file is unknown. Use `symbol:<file>#<selector>` to read one declaration. Use `graph:<file>` for the file's top-level declarations and relationships, or `graph:<file>#<selector>` for incoming and outgoing references of one declaration.

Pass a result scope to `symbols:` for strict discovery inside its exact ranges. Read the displayed definition/reference and symbol information. Name equality alone does not establish reference identity.

Use `navigation: "references"` only when following symbols represented inside the input scope to references outside it. Navigation stays within the workspace. Path and globs define the seed scope in this mode, not the destination references. Omit navigation for strict discovery. Incomplete, failed or unavailable provider results do not prove absence. Text replacement through an LSP match changes only that range; it is not semantic rename.

Append `#name` to an exact symbol resource only for a native language-server rename across references. If semantic support is unavailable, use a precise text or AST operation instead of pretending it was a semantic rename. Pending or empty language-server output does not prove that no declaration or reference exists.

## Other search protocols

Use an HTTP(S) URL as `path` to search converted page text with a literal or `regex:` query. No prior Read is needed. Web results keep the requested URL and do not expose editable `SEARCH#` references. Use Read on that URL for more context.

Use `process:<query>` for running processes. Use `path: "shell:<session>"` to search retained terminal output beyond its current tail.
