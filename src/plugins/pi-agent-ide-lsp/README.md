# LSP plugin

This extension adds LSP diagnostics to normal filesystem reads, the `lsp_search` tool, and native rename through declaration name captures.

## lsp_search

Pass exactly one mode:

- `query`: workspace symbol search for declarations and references. `path` (file, directory or a returned result), `include` and `exclude` narrow it. `references: true` follows symbols found inside `path` to their references anywhere in the workspace. Each definition line shows the selector of its declaration, so the overloads of a name are listed apart, for example `selector main.cpp#clamp(int, int, int)`. A query that is one identifier also lists the files under `path` that write it as a whole word (ripgrep, locally or on the SSH owner), opens each one so its server picks the project that owns the file, and takes the declarations whose name range holds the identifier from that file's document symbols. A server's workspace index covers only the projects it has loaded, such as the TypeScript project of its first file, one clangd compilation database or one Go module, so this finds the declarations in sibling projects too. The workspace index still answers other queries, for example abbreviations, and adds its own matches to the exact ones. At most 64 files are opened per search; the rest, and an owner that cannot search text, make the result incomplete and are named in its notes. The server's workspace index can lag behind edits from other sessions; the declarations of a name are then taken from the file's current document symbols, and reference requests use the declaration's position in the text the server holds.
- `declaration: "<path>#<selector>"`: the declaration's complete lines as a guarded `SEARCH#` selection, with a `name` capture for its identifier. A selector uses `/` for nesting, for example `UserService/getUser`. A one-part selector finds a nested symbol only when that name is unique in the file; a multi-part selector must match the document-symbol hierarchy exactly. See [Selectors and overloads](#selectors-and-overloads).
- `calls: "<path>#<selector>"`: the definition, references grouped by file, incoming calls and outgoing calls. `calls: "<path>"` reports every top-level declaration in source order with the same relations and lists direct members with their `calls` values. When the server does not implement a call direction, such as outgoing calls in clangd 18, that section says so and the other relations are still reported.

`<path>` may be relative to the session directory or absolute. The tool runs its resolver through the shared Search execution core, so scopes, SSH owners and selections behave as in `search`; it is not registered as a `search` query form.

### Selectors and overloads

A selector segment is a name, or a name with parameter types that names one overload: `clamp(int, int, int)`, `Box/get() const`. Types are compared with the signature the server reports in the document symbol's `detail`, such as clangd's `int (int, int, int)`. Spacing does not matter (`const Vec&` and `const Vec &` are the same), parameter names and default values copied from a declaration are ignored, and `(void)` is `()`. Trailing qualifiers such as `const` tell methods apart; a segment without them prefers the unqualified overload.

Entries with the same name, kind and signature in one scope are one declaration, such as a C++ prototype and its definition. References, calls and renames are the same from either entry. A `declaration` selection takes the definition when the outline contains exactly one entry with a body. Otherwise it selects the first declaration. Replacing the issued name capture runs a semantic rename across the selected symbol's declarations and references.

When a selector names several declarations, the error lists a selector for each. Servers whose document symbols carry no signature, such as most TypeScript and Python servers, cannot tell overloads apart this way; their error says so.

## Editing targets

Pass an `lsp_search` declaration result or its match to `replace`, `copy`, `move` or `delete` to edit its text. Imports and references stay unchanged. Complete-line selections include their final newline; include that newline in replacement text when keeping adjacent declarations on separate lines.

A declaration also exposes `capture name: RESULT#…`. Pass that capture reference as `replace.path` and the new identifier as `text` to rename through the language server. In Codemode, use `declaration.matches[0].captures.name[0]` or its `id`. A rename requires one capture, non-empty text and no start/end. The server updates references, imports and shorthand forms, and the result identifies the native rename. A stale capture fails without a text-replacement fallback; repeat `lsp_search` to acquire a fresh one.

## Server lifecycle

A language server starts on the first request for a file it handles, such as post-edit diagnostics or `lsp_search`. Documents opened for a request close when it finishes, unless another request still uses them. A session that sends no requests for 10 minutes releases its server, and the next request starts or reconnects it. Change the timeout with the `lsp.idle-timeout` IDE setting, in minutes.

Pi sessions on one machine share a local server when they use the same server, command, configured environment, project root, initialization options and settings. The first session starts a background host process that runs the server; later sessions connect to it. Each session still sees its own document text, versions and diagnostics. The host keeps a document open on the server for 5 seconds after the last session closes it, so a request right after another one does not make the server analyze the file again. The host stops the server `lsp.idle-timeout` minutes after the last session disconnects, so a new session in that window gets a server that has already indexed the project. If a session cannot reach a shared server, it starts its own. Servers on SSH hosts are not shared; each session runs its own.

File watches that servers request cover only the project: patterns based on a parent directory see only files inside the project, and patterns based elsewhere are ignored. `.git` is not watched, and `node_modules` is watched only for packages added or removed.

## Text the server holds

Opening a file for a request publishes the text that is on disk at that moment, and a single request opens files several times: a diagnostics or coverage check opens the same file again after its symbols were read. While another session writes that file, the server's text therefore moves ahead of the text a position was read from, inside one request.

A position sent to the server is mapped onto the text the server holds and checked against it, and an answer is mapped back onto the text its hits are reported from. Both use the line diff that follows unchanged lines. When the line a position belongs to is gone from the other text, or the server replaces its text while it answers, the request fails with `SOURCE_CHANGED` and runs again on the current text. `lsp_search` with `references: true` and with `calls:` map their positions this way; a call graph reports every line from one text of each file, read once per graph. A declaration name-capture rename checks that the server answers for the text it read in every participant. At write time it can reuse a C-family plan only if the range tracker and the ordered layout check agree on every edit. A header macro can observe the column of its expansion, so the layout check requires unchanged indentation when it detects preprocessing syntax. Matching an identifier's spelling does not prove that it refers to the same declaration.

## Failures

Malformed selectors, missing symbols, missing files and unavailable LSP servers return failed results. They never fall back to text search.

For C and C++, `calls` and `declaration` retry a selector miss when the identifier still occurs in the text sent to the server. Only a matching declaration in the server's outline can resolve the selector. If the retries cannot confirm it, check the current outline before trying again. Ambiguous selectors are not retried.

A `declaration`, `calls` or `references: true` search has one 15-second deadline for startup, queries, coverage checks and retries. If the server cannot answer before the deadline, the search reports a timeout. C/C++ coverage notes distinguish files skipped during the name scan from open files whose diagnostics were unavailable. An empty server reply for a known C/C++ declaration does not establish that it has no references. If the server cannot resolve a callable declaration for the hierarchy, the graph keeps any references and marks the calls unavailable. A server's index can still name places in files that were deleted since, such as another session's scratch copy of a source. Symbol searches and call graphs leave those places out, keep the rest, and name the deleted files in the result. Those places do not exist in the workspace, so they do not make the result incomplete.

A server that reports loading the project through `experimental/serverStatus`, as rust-analyzer does for several seconds after it starts, answers from the part it has seen so far, often with nothing. Symbol searches, declarations, call graphs and diagnostics wait until it reports that loading finished, and a request answered during loading is sent once more afterwards. `diagnostics` shows the language server as pending while it waits. If loading exceeds the search deadline or the server's request timeout, the request fails instead of returning an empty result. Servers shared between Pi sessions repeat the latest status to sessions that attach later.

Diagnostics are pulled (`textDocument/diagnostic`) from servers that support it, including servers such as pyright and basedpyright that register pull diagnostics after they start. A pull returns the server's complete report for the current text. Pushed reports can be interim: pyright can push an empty report for a version and the report with its errors seconds later. When a pull server asks for new pulls (`workspace/diagnostic/refresh`), diagnostics of the files being checked are pulled again once these requests pause for 750 ms, or after 3 s while they keep coming. A repeated pull of the same text sends the previous result id, so the server can answer that nothing changed.

A server that exits during startup, such as the rustup proxy when the `rust-analyzer` component is missing, fails the request at once with the exit code and the server's last error output. `lsp_search`, name-capture renames and `diagnostics` show that message. The failure is not remembered: the next request starts the server again, so installing it takes effect without restarting Pi.

A server may cancel a request because a document changed while it worked (`ContentModified`) or because it dropped the request (`ServerCancelled`), as rust-analyzer does while several sessions edit. Such a request is sent again up to 5 times over about 1.5 seconds, unless the server says a retry will not help or the caller stops waiting. Only a request still cancelled after that fails with the server's message.

## Demo

Run the live TUI replay:

```bash
./scripts/interactive-demos/run-read-code-views-tui-loop.sh
```

The demo copies `src/code-view/reference.ts` into an isolated TypeScript project and shows the `outline` result and `lsp_search` declaration, symbol calls and file calls results in order.
