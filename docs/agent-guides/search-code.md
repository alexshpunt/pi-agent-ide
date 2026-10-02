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

Pass a source-aware Read/Search/replace/insert result, its `data`, a `RESULT#` reference, or an array of returned matches/resources as `path` to search their exact source ranges. Local text, `regex:`, `ast:`, and `symbols:` queries support this input. Sparse ranges and files stay separate; gaps and neighboring text are not searched.

A replace/insert result searches only that call's resulting text, including an empty resulting position. In native Codemode, passing a pending result commits the batch first. Final formatting runs at script end; targets from before changed formatting become stale, not silently rebound.

Pass `found.data.matches.filter(...)` to narrow a result with JavaScript. A whole result's `target` still selects its complete stored scope; changing its preview does not narrow it. Preserve returned target handles instead of reconstructing coordinates from text.

Check `complete` before treating zero matches as absence. Inherited incompleteness survives non-empty subsets. Empty arrays select no sources; they do not default to the workspace. Result-scoped text Boolean queries and text include/exclude globs remain unsupported. AST and LSP providers retain their own path/glob filters. File/process and unsupported provider scopes fail without widening the scope.

## AST search

Use `ast:<pattern>` for syntax-aware matching. `$NAME` captures one syntax node and `$$$BODY` captures several nodes. Returned search references can select multiline matches for read, replace, copy, move, delete, and Apply. An incomplete result does not provide a complete all-selection. Text replacement through an AST selection does not update imports or references automatically.

Pass `found.data.matches[index].captures.NAME` to Search or replace to use an AST capture without Select. Each name contains an array of source targets associated with that parent match. Multi captures retain all provider nodes, including punctuation; an absent or empty capture is not an invented source range. Use ordinary JavaScript to choose nodes. AST matches and captures must be wholly contained in one requested region; they are not clipped at a scope boundary.

```js
const window = await tools.read({ path: "client.ts", offset: 10, limit: 4 });
if (window.status !== "success") throw Error(JSON.stringify(window.errors));
const calls = await tools.search({ path: window, query: "ast:request($OPTIONS)" });
if (calls.status !== "success") throw Error(JSON.stringify(calls.errors));
const options = calls.data.matches[0]?.captures.OPTIONS;
if (options === undefined) throw Error("No captured options");
const values = await tools.search({ path: options, query: "1000" });
if (values.status !== "success") throw Error(JSON.stringify(values.errors));
const changed = await tools.replace({ path: values, text: "2000" });
text(changed);
```

## Symbols and graphs

Use `symbols:<query>` to locate declarations and references when the source file is unknown. Use `symbol:<file>#<selector>` to read one declaration. Use `graph:<file>` for the file's top-level declarations and relationships, or `graph:<file>#<selector>` for incoming and outgoing references of one declaration.

Pass a result scope to `symbols:` for strict discovery inside its exact ranges. Inspect `matches[].role` (`definition` or `reference`) and `matches[].symbol` for the originating declaration's identity, name, kind, source, and range. Name equality alone does not establish reference identity.

Use `navigation: "references"` only when following symbols represented inside the input scope to references outside it. Navigation stays within the workspace. Path and globs define the seed scope in this mode, not the destination references. Omit navigation for strict discovery. Check `complete`; failed requests and unavailable providers are errors, not proof of absence. Text replacement through an LSP match changes only that range; it is not semantic rename.

Append `#name` to an exact symbol resource only for a native language-server rename across references. If semantic support is unavailable, use a precise text or AST operation instead of pretending it was a semantic rename. Pending or empty language-server output does not prove that no declaration or reference exists.

## Other search protocols

Use an HTTP(S) URL as `path` to search converted page text with a literal or `regex:` query. No prior Read is needed. Web results keep the requested URL and do not expose editable `SEARCH#` references. Use Read on that URL for more context.

Use `process:<query>` for running processes. Use `path: "shell:<session>"` to search retained terminal output beyond its current tail.
