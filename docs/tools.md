# Tools and workflow

Pi Agent IDE explores a small tool surface for coding agents. The goal is to keep common operations easy to call while letting resolvers and plugins handle source-specific work.

The project is experimental. The behavior below describes the current implementation, not a performance guarantee.

## Tool discovery

Read, Search, File Search and the common editing and terminal tools are declared initially. AST Search, LSP Search, Diff and Undo are deferred, alongside Stage, Unstage and Debug. Discover them with `tool_search`, or use `describeTool()` inside Codemode when the tool name is known. Deferred tools remain callable from scripts.

Use AST Search for syntax patterns, captures and enclosing code. Use LSP Search for symbol definitions, references and call graphs through language servers.

## Readable results and composition

IDE tools return readable text in direct calls. A leading system-result envelope carries a registered UUID; it is not file content. Pass the unchanged result to another source parameter, or use its UUID in a direct call. In Codemode, several tools return values instead, such as Read's `{ text, id }`. Source parameters take any object whose `id` is such a reference, including these values; its other fields are ignored. The system resolves the private source records. Check the readable file effects before retrying failed edits. See [IDE result composition](./structured-results.md) for reference lifetime and automatic commit boundaries.

## Shared output limits

Readable IDE results, including nested panels and the combined Codemode result, share a useful-text limit of 50 KiB or 2,000 lines. Images share a limit of 20 frames, 4,000,000 pixels and 20 MiB of image bytes per result. Notices, guides and composition references are added afterward and are not part of these budgets. Codemode values can contain more than a readable result: Search returns every match it found, for example, and file_search returns all paths unless given a limit.

A text Read inside a Codemode script likewise returns its complete requested text: the script receives `{ text, id }` with the whole requested text, so it can parse a large file or write it back. Explicit `offset` and `limit` select exactly that window. Notices and continuation hints stay out of `text`, and large files are not replaced with a code overview. The script's own output is still bounded: the combined Codemode result shares the limit above. The Read panel inside the Codemode card shows the first 2,000 lines or 50 KiB of such a result and says that the script received all of it.

Diff is another exception: in a Codemode script it returns the complete unified diff as a string, without the system-result envelope, and `""` when the sources are equal. A direct Diff call shows the bounded diff and saves the full one as a temporary result that its truncation notice names.

When the shared text limit truncates a result, the complete useful text is saved to a private temporary file. The result names that file. Use Read with `offset` and `limit` to continue, or `raw:` byte windows for a line that is too large. The file is removed when its owning runtime is disposed. Media is resized or omitted, not archived.

An explicit request limit still selects what the tool produces; the saved file does not undo that filter. Truncation does not shorten private source selections or change file-edit effects. Terminal results also link to their complete session log.

## Resource references

Tool source fields take one complete resource reference. A filesystem path is the common case, but it is not the only kind of reference. Depending on the tool and loaded resolvers, a reference may name a file, URL, protocol source, temporary result, or a typed text selection.

Read accepts a file or directory path, resource address, or issued result. Pass an array to read each source independently in order. Unsupported sources return an error. Built-in address forms include `raw:<file>` for bytes, `temp:<id>` for saved output, `ast:<file>` for a declaration outline, `diagnostics:<file>` for diagnostics, and `docs:<id>` for a guide. HTTP(S) URLs are fetched locally; `web:ssh://<target>/https://…` fetches on that target. Extensions register further resource addresses.

A typed `SEARCH#...` value is both an anchor and a resource reference. It carries its source or sources and its selected ranges. Pass it by itself in either role:

```ts
replace({ path: "SEARCH#19AF:all:match", text: "new" });
replace({ start: "SEARCH#19AF:all:match", text: "new" });
```

Do not append it to a filesystem path:

```ts
replace({ path: "src/file.ts:SEARCH#19AF:all:match", text: "new" }); // wrong
```

A source field such as `path` or mutation `target` is therefore a resource field even when its name reflects the familiar filesystem case.

## SSH resources

Configure a Linux SSH target, then use `ssh://target/path` with the supported existing tools. The resource keeps its target owner through Read, Search, editing and transfers, Git, language tools, terminal and debugger sessions. Target-native web reads use explicit remote sources rather than changing where ordinary URLs execute.

Authentication stays in OpenSSH. Target programs require their dependencies on that machine; missing support does not fall back to local execution. See [SSH configuration](./configuration.md#ssh-targets) and the [SSH guide](./agent-guides/ssh.md) for setup, prerequisites and supported sources.

## Read

`read` resolves a source and returns agent-ready content. Built-in resolvers currently cover:

- local and configured SSH text files and directories;
- images and PDFs;
- HTTP and HTTPS resources;
- HTML converted to readable Markdown;
- AST-aware code views;
- LSP diagnostics, symbols, references, and call graphs.

A read result may include anchors, diagnostics, Git changes, or structural markers. Large text results are bounded. The shared limiter retains complete truncated text in a temporary file.

Read sources are not assumed to be writable. The read and text-editor cores keep separate resolver registries so a derived view cannot be edited by accident.

HTTP(S) pages use a fast direct request first. Failed requests (including HTTP 403 and timeouts), failed HTML conversion, and empty HTML automatically trigger one retry through local Chrome or Chromium within the same `read` call. The browser gets a fresh timeout; caller cancellation stops both attempts. If the browser also fails or is not installed, the read reports both failures. Successful non-HTML reads and non-HTML conversion errors keep their normal behavior. Browser rendering removes hidden elements before the same HTML-to-Markdown conversion runs.

Browser reads discover `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser` on `PATH` and in common Linux locations. Set `PI_AGENT_IDE_BROWSER_PATH` to use another executable. Missing browser support returns a normal read failure and `/agent-ide-doctor` reports it as an optional warning. Browser reads execute page JavaScript. When Pi runs as root, Chromium is launched without its process sandbox; only open sources you trust in that mode.

When `path` is a typed text resource, `read` returns one independent chunk for each selected range, in resolver order. Each chunk starts at the range's containing line. `offset` and `limit` are applied to every chunk, not across the combined result. The chunks are then joined and the normal aggregate limit of 2,000 lines or 50 KiB is applied.

When `path` is an array, `read` reads each source on its own with the same `offset`, `limit` and `views`, and shows each result under its source. The call fails as a whole when any source fails; the other sources' results are still shown. In Codemode it returns an array of values in the same order, with `null` for each source that failed, and the Codemode result lists only the failed sources.

### Original bytes

Use `read({path: "raw:sample.bin", offset: 0, limit: 64})` to inspect original file bytes, including PDF and image headers. For remote bytes, use `raw:ssh://target/path`. In `raw:` mode only, offset is zero-based in bytes (negative from EOF), and limit is a non-negative byte count. The output shows hexadecimal offsets, hex bytes, and printable ASCII. Follow its returned byte offset to continue. No views or text anchors apply.

In Codemode, a `raw:` Read returns `{ bytes }`, the base64 of every requested byte; the Read panel shows the bounded hex view. This is read-only; byte editing and byte diff are not included.

### Diagnostic completion

Edits save before background diagnostics finish. Automatic notifications show only sources with findings, in the chat as soon as they arrive, with a matching hidden message sent to the agent. A new finding wakes an idle agent; during a run it is queued as steering input for the next model call. Each source names the actual reporting command, such as `eslint_d` or `typescript-language-server`, rather than a wrapper extension. Chat summaries show that name in parentheses beside its counts. Pending, unavailable, and empty reports stay silent, including updates that clear earlier findings. Silence does not mean checks passed. Explicit `diagnostics:<path>` reads and the diagnostics view still return details and readiness.

LSP reads prefer standard pull reports. Servers that advertise a supported completed-request command can use an adapter; TypeScript language server uses one adapter for both TypeScript and JavaScript. Adapter selection uses server capabilities, not language names. All requests remain tied to the synchronized document revision and are canceled when it becomes stale.

Other push-only servers return a `snapshot`: the latest publication, with no promise that every check has finished. This also applies to versioned pushes. An empty snapshot is not a completed clean report. For example, clangd publications remain usable C++ snapshots without invoking TypeScript commands. Later pushes from pull-capable or adapter-backed servers trigger a fresh completed request rather than replacing it with a partial publication.

## Terminal sessions

In Codemode, `bash`, `powershell`, `remote_bash` and `remote_powershell` resolve to the fields of Pi's own `bash`, plus the session: `{ output, exit_code, truncated, full_output_path, wall_time_seconds, session }`. `output` holds up to 1 MiB; longer output keeps its first and last 512 KiB around an omission marker such as `[... 351432 bytes omitted ...]`, with `truncated` set. `full_output_path` is the complete log. `session` is the `shell:<session>` source, which stays readable after the command ends. A background command, or one still running when its wait times out, has no `exit_code` yet. A non-zero exit code is a value, not a failure: the script gets it, and the Codemode result does not list the call as failed. Only a command that cannot start, such as one with an unknown SSH target, resolves to `null`; the Codemode result lists it with its reason. A direct call still shows readable status and output and reports a non-zero exit code as an error.

```ts
const result = await tools.bash({ command: "your-command" });
if (result !== null && result.exit_code !== 0) text(result.output);
const server = await tools.bash({ command: "npm run dev", background: true });
if (server !== null) {
  const status = await tools.read({ path: server.session });
  if (status !== null && "text" in status) text(status.text);
}
```

`bash` (Linux/WSL) or `powershell` (Windows) starts a command in the user's configured system shell. Its schema and prompt guidance name that shell at runtime, so the agent writes Bash, zsh, PowerShell, or Command Prompt syntax as appropriate. Commands are not translated between shell languages.
A native Windows session offers only `powershell` for local commands; Pi's built-in `bash` (Git Bash) is withdrawn, also after a Teleport from Linux, a reload or a resume.

Every run returns a stable `shell:<session>` source. Synchronous runs wait for the real exit status. Background runs return immediately, remain visible below the editor, and send one completion message that wakes the agent; nearby completions are combined without losing individual results. `/terminals` opens the active and recent session overlay.
The UI tab in `/agent-ide-settings` controls persistent active-terminal presentation: Detailed cards (default), Compact count, or Off. Detailed cards replace the separate active count instead of showing both. This setting does not hide ordinary run results or completion messages.

Use `read` on the returned source for status and bounded output. Compact cards show the latest 12 output rows and count omitted earlier rows; expanded cards show all retained rows. Add `views: ["image"]` to receive a PNG of the ANSI-aware virtual terminal screen. Use `write` to send exact text without Enter. Use `insert` for named keys and chords such as `Enter`, `Ctrl+C`, `Ctrl+Shift+Left`, or Unix caret controls such as `^U`; separate multiple keys with spaces or commas. A native Codemode script can send several terminal inputs without file formatting or diagnostics. Use `search` with the `shell:<session>` path to search retained output, including rows outside the current screen; the query is literal text, or a regular expression when it starts with `regex:`. `delete` terminates the owned process tree when needed, disposes the virtual screen, and removes the session. `replace` does not apply to terminal sessions.

For a bounded terminal sequence, use `views: ["sequence:duration=2,interval=0.5,scale=1"]`. This returns five PNG frames over two seconds. Duration is capped at 10 seconds and each sequence at 20 frames. Terminal images and sequences support scale from greater than 0 through 1; they do not support region or grid-cell selection.

Deleting an active session first requests graceful termination, then forcefully terminates its process tree after the grace period. Deletion does not undo file or network effects. Sessions survive extension reloads in the current Pi process. Shutdown stops live processes; sessions are not reattached after restart.

## Search

`search` gives the agent one discovery interface. Built-in resolvers cover:

- file content search;

A resolver decides whether it understands a query. The first successful resolver returns the result. Search plugins can add new query forms without adding another agent tool.

Local text search tries literal terms first. If there are no matches, it retries unquoted terms as regex. If that also finds nothing, an ordinary multi-word query falls back to separate words. Each fallback is reported. Invalid optional regex is skipped, while I/O errors, cancellation, and regex runtime errors stay errors. The exception is a path that ripgrep cannot read while it searches the rest of the scope, such as a WSL symlink seen from Windows through `\\wsl.localhost`: the search returns the matches it found with one notice that counts the skipped paths and names the first. `regex:<pattern>` forces regex-only matching and reports invalid patterns.

After all ordinary attempts finish with zero matches, a single unquoted ASCII identifier can return separate possible-name groups. They cover naming-style changes, one extra or missing edge component, and small typos, strongest first. Each name is verified exactly in the same scope. These are spelling suggestions, not synonyms, automatic corrections, or proof of equivalent behavior. Quoted, Boolean, explicit regex and other protocol queries do not use this branch.

Local groups provide current Read selections; a complete candidate all-reference refreshes only its exact alternative. URL groups reuse the already converted page text and provide URL line ranges without editable Search references. Name collection, capture and output have fixed budgets; a skip or limited capture is explicit. Narrow the scope if a budget is reached.

Boolean queries keep their conditions across literal and regex attempts. They support uppercase `AND`, `OR`, `NOT`, `||`, and space-separated `|`. Adjacent terms imply `AND`; `AND` and `NOT` bind more tightly than `OR`. `NOT` excludes lines from its conjunction wherever it appears, so `a NOT b`, `a AND NOT b`, and `NOT b AND a` are the same query; a conjunction needs at least one term without `NOT`. Parentheses containing Boolean operators group conditions. Regex groups, classes, and escapes stay inside terms: `(?:foo|bar)\d+ AND "keep.me" NOT ignored`. An unspaced `foo|bar` is searched as literal text first, then as regex alternatives. Single or double quotes keep a term literal in every attempt. Quoted and Boolean queries never fall back to separate words. Invalid Boolean expressions report the source column and expected syntax.
Boolean text searches also work with registered result scopes. Each selected range is searched on its own: terms outside it, in sparse gaps, or on another line cannot satisfy a condition.

A Boolean search or separate-word fallback can select individual tokens instead of the original phrase. Search warns about these selections and prevents editing or transferring the whole result or an `all` anchor. Read or search the result to inspect it, edit a numbered match, or quote the original query to search for the literal phrase.

Empty protocol queries such as `regex:` and unhandled prefixes such as `unknown:needle` search their original text, including the prefix. The tool reports this fallback. Nonempty installed protocols keep their specialized behavior; service errors, timeouts, and successful protocol searches with no results do not launch local text search. Plugins mark a local fallback resolver with `fallback: true`; these resolvers run after specialists regardless of numeric priority and receive empty protocol queries directly.

An omitted or empty `path` searches the session directory. An explicit `null` argument fails the call in `search`, `file_search`, `ast_search` and `lsp_search` instead of counting as omitted. A null source such as `path: null` means the call that produced it failed or selected no text, such as a directory copy or a `delete`, and searching everything instead would hide that; the same holds for `include`, `exclude`, `query`, `pattern` and the other text arguments. In Codemode the failed call resolves to `null` and is listed in the script's failure block. A null in a number, boolean or object argument, such as `limit: null`, is rejected as invalid arguments. Pi drops a null optional property before a tool runs, so each tool keeps the null visible in `prepareArguments` and refuses it in `execute`.

A complete search call times out after 30 seconds by default, including resolver work and result formatting. The timeout cancels the active resolver and tells the agent to retry with a smaller `path` scope. Global and project `search.json` files can change or disable the timeout as described in [Configuration](./configuration.md#search-timeout).

Direct local text and regex results can expose four reusable forms:

- `SEARCH#HASH:N:line` selects result `N` as a whole line;
- `SEARCH#HASH:N:match` selects the exact match for result `N`;
- `SEARCH#HASH:all:line` selects each unique containing line once;
- `SEARCH#HASH:all:match` selects every exact match.

Every response that includes these values includes an `Anchors:` syntax legend after any fallback notices. Bare `SEARCH#HASH:N` and `SEARCH#HASH:all` values are invalid and are not displayed.

These values are both edit anchors and typed text resources. `read` and mutation `path` fields accept each complete `SEARCH#...` value directly; no filesystem path is added before or around it. The text search resolver turns them into ordered Resource sources and character ranges; consumers use that typed result and do not parse the `SEARCH#` string themselves.

A `:line` range includes its LF or CRLF line ending. A whole-line replacement preserves that separator when the replacement text does not provide one. Insertion happens after the line by default and before it when `before: true`. A final line without a line ending selects through EOF and stays without a trailing separator when replaced, unless the replacement text provides a line ending. Whole-line deletion removes only that line and its own terminator, when present. An unterminated final line never consumes the preceding separator. Empty Replace removes the same range as Delete. Adjacent whole-line deletions are coalesced. A `:match` range contains only the matched characters, so deleting it keeps surrounding text and line endings.

Per-result forms keep the search-time snapshot and fail as stale after their matched file changes. Complete `:all` forms rerun the original search recipe when a matched file changes, then select the current complete result set. A search that ran inside a Read or Search result reruns inside that result as its file is now, also for `ast_search` and `lsp_search`. Limited or otherwise incomplete searches omit the `:all` forms. A forged `:all` value for an incomplete search is rejected.

When an `:all` form cannot be used, the error says why and what to do: the search was limited, the rerun found more matches than its limit, the result it ran inside is no longer in the file, the file kept changing while the search ran again, or the rerun failed with its own reason. An edit retries a file that changed during the rerun, like any other change by another process. A retry of the same edit does not search again when it can avoid it: it moves the matches the earlier attempt found onto the newer text through unchanged lines. It searches again when a match's own line changed or moved, or when an added or changed line contains a matched text and so may hold a new match.

## File search

`file_search` finds file paths under `path` (default: the session directory), locally or on an SSH target. A `pattern` with glob syntax (`*`, `**`, `?`, character classes, braces) matches paths relative to `path` when it contains `/`, and file names at any depth otherwise. Other patterns match as a case-insensitive subsequence of the relative path. `include` and `exclude` narrow the scan; `.git` is skipped and ignore files are honored. Results are sorted, limited by `limit` (default 100), and mark an incomplete list when the limit is reached. In Codemode, `file_search` resolves to the paths as a `string[]`, and without `limit` it lists every matching file.

## Syntax search

`ast_search` runs [ast-grep](https://ast-grep.github.io/) in files or inside a returned Read, Search or edit result, for every language ast-grep supports. It takes either a `pattern` in source-code syntax, with `$NAME` and `$$$ARGS` captures, or an ast-grep `rule` object with a `language`. Rules add relations such as `inside`, `has`, `not`, `follows` and `precedes`. With a result as `path`, `relation: "enclosing"` returns the innermost match that contains each range, for example the function around a text match. Matches and captures are guarded `SEARCH#` and `RESULT#` selections like text search results. Pi Agent IDE ships its own ast-grep for local projects, so no system-wide install is needed; SSH targets still use the `ast-grep` on their own PATH. If the bundled ast-grep cannot start, the tool is not offered and the doctor names the reason. The agent guide is `docs:ast-search`.

## Language-server search

`lsp_search` asks the project's language servers. `query` finds declarations and references by symbol name in the workspace, a path or a returned result; `references: true` follows symbols found inside that scope to references elsewhere in the workspace. `declaration: "file#selector"` returns one declaration as a guarded `SEARCH#` selection; a selector segment with parameter types, such as `clamp(int, float)`, names one overload, and each definition in a `query` result shows its selector. `calls: "file"` or `calls: "file#selector"` lists references and incoming and outgoing calls. Editing tools keep accepting `symbol:<file>#<selector>` paths, and `symbol:<file>#<selector>#name` triggers a native rename.

In Codemode, `query` and `declaration` resolve to `{ id, complete, matches }` like Search, with every match unless `limit` is set; a declaration's one match holds the whole declaration. `calls` resolves to `{ id, complete, matches, incoming, outgoing }`: references in `matches`, and each caller and callee as its whole declaration, in whole lines like `declaration`. A call at module level has the whole file as its caller in TypeScript, so that `incoming` entry selects the whole file. A file's calls merge the lists of its top-level declarations. `id` selects the references, and each match's `id` selects that match. `complete: false` marks C and C++ answers that can miss references, as below, and calls in a direction the server does not support.

For C and C++, clangd needs extra handling. After a fatal clang error, clang stops instantiating templates. The 20-error limit is one such error and a missing `#include` is another. Code after it that needs a new instantiation then has no references, and clang reports nothing there.

- Pi starts clangd through a small POSIX launcher. The launcher writes a clangd user config that adds `-ferror-limit=0`, followed by the user's own `clangd/config.yaml`, to `~/.cache/pi-agent-ide/clangd-config`, or to a private temporary directory when that is not writable. User config takes precedence over a project's `.clangd`, so only a limit in the user's own config still applies. clangd reads this config on Linux and other non-Apple Unix systems.
- Before references, the calls of one symbol and a rename, Pi opens up to 32 workspace files whose text contains the name. It finds them with `rg` on the machine that owns the files. Their references then come from a fresh parse instead of clangd's background index, which parses whole files and lags behind edits.
- A fatal clang error in a file the answer depends on, or more files than the limit, marks `lsp_search` and the calls view incomplete and names the files. An LSP rename in that case changes nothing and says why.
- The calls of a whole file check only files that are already open.

## Narrowing a result

Search inside a returned Read, Search or edit result to narrow it before editing. A regex inside the result selects a span between markers, part of a line or an insertion point; `multiline: true` lets one match span several lines. `ast_search` on the same result selects construct parts such as a function body or an argument list through its captures, or the function that encloses a match, and `SEARCH#...:line` references select complete containing lines. Displayed context alone does not expand an edit selection.

## Editing

Pi's built-in `edit` tool identifies a replacement with `oldText` and `newText`. Pi Agent IDE uses explicit mutation operations that can target snapshot, search, structural, and other registered anchors.

The text editor currently provides these mutation tools:

- `write`;
- `replace`;
- `insert`;
- `delete`;
- `copy`;
- `move`.

They share the same Resource and anchor contracts. A mutation can resolve one or more Resources, validate its anchors against the current text, preview changes, run guards, write the result, and trigger post-edit feedback.

Use an ordinary path without text selectors for whole-file Write or whole-object Delete, Copy, and Move. Copy and Move require an explicit destination path. They support regular files, directories and symlink objects, including local/SSH transfers. Directory merge/replace behavior, safety checks and uncertain effects are described in [directory operations](./directory-operations.md).

Write `content` is a plain string and is saved exactly as given, including JSON text such as `{"a": 1.0}`. A parameter that also accepted objects would let the tool-call layer parse JSON-looking text into an object, so images use a separate parameter. To save an image a Read returned, such as a terminal screenshot or image file, pass that Read result as Write `image` instead of `content`: the image value itself in Codemode, or the result's UUID or `RESULT#` reference in a direct call. Write saves the exact image bytes, and the file extension must match the image type (`.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`). Several frames become numbered files: `<name>-01.png`, `<name>-02.png`… beside the path, or `frame-01.png`… inside a folder path. A call takes exactly one of `content` and `image`. Text in `content` is never treated as an image, even when it is an image result's UUID; `image` refuses anything other than an image result, including the reference of a result without images. Images are written to local files only.

For selected-text work, a path identifies the source and anchors identify the span. Pass an unchanged Read, Search or mutation result when it already selects the wanted text. `replace` changes each selected range; `delete` removes those ranges while keeping the file; `insert` adds text at the selected range's start or end. Whole-line selections, including exact text of a complete line, add needed line breaks; partial-line selections insert at their character boundaries. A directory listing or read-only view does not grant text-edit authority.

A result passed together with selectors (`start`/`end`, `anchor`, `targetStart`/`targetEnd`) limits them to its ranges: they resolve in the result's file, exact text needs to be unique only inside those ranges, and a selector outside them, or a pair in two different ranges, fails and names the result's selection, such as `task.txt line 2`. With a result of several files, the edit goes to the one file whose selection holds the selector. Selector parameters also take a value with an id, such as a Search match in Codemode, as source parameters do.

Narrow a result with Search rather than reconstructing boundaries from previews. Copy and Move can pair source and destination selections, with equal counts. With ordinary file paths, text transfers use `targetStart` as the insertion anchor or `targetStart`/`targetEnd` as the replacement range. These selectors do not apply to whole-object transfers.

Use `start` alone for an exact fragment or one line selection. Paired `start`/`end` and `targetStart`/`targetEnd` preserve each endpoint's extent: exact text and `SEARCH :match` keep character boundaries, while line anchors and `SEARCH :line` keep whole-line boundaries. A pair runs from the beginning of its first endpoint through the end of its last endpoint, including the ending match. Mixed types retain their independent extents. Snapshot-backed selectors reject changed files; missing or ambiguous exact text is rejected rather than guessed.

Independent standalone edits in one tool-call batch use their original snapshots. Inside native Codemode, run dependent edits in order and independent resources concurrently. Dependent source-tool calls commit eligible pending edits before consuming their results; script completion saves the remaining batch. Write saves its file and finishes post-edit processing before returning. No Apply or Flush tool is needed.

In Codemode, `replace`, `insert`, `write`, `copy`, `move` and `undo` resolve to the `RESULT#<uuid>` id of the text they produced when the selection is verified; a whole-file Copy, Move or Undo of a text file selects the whole new file. Pass it to the next tool's source parameter: `tools.search({ path: await tools.replace(…), query })`. An id of an edit still pending in the script's batch works too; that call commits the batch first. An edit whose targets already have the text writes nothing and still resolves to the id of that text. An edit that selects no text, such as a directory or binary copy, terminal input or an image Write, resolves to `null`; filesystem and text `delete` resolves to `null`; a provider action keeps its value or receipt. A successful edit also resolves to `null` when its output selection cannot be verified, for example if another process changes the file before publication. Check the Codemode result's failure block to distinguish failed calls, and read the file before further edits when there is no verified selection. A resource provider's semantic action, such as a computer-use action, resolves to the value the provider returns. The Codemode result reports the text changes of the script's edits and lists every failed edit in its failure block.

Several Pi processes on one machine can edit the same file. Their reads and writes of a file run one at a time, and a write replaces the file in one step, so neither Pi nor other programs such as ripgrep or a language server read a half-written file, and a write never replaces text that changed after its edit read the file. Such an edit runs again on the current text: exact text, line anchors, AST scope markers, `symbol:` selectors and complete `SEARCH#…:all` forms resolve again, and `RESULT#…` and numbered `SEARCH#…` references, also those of `move` and `copy`, move to their new positions or fail with their current lines when their own text changed, in every field (`path`, `start`/`end`, `anchor`, `target`, `targetStart`/`targetEnd`) and in the check before a direct call alike, always in the text the edit reads; a line anchor fails when its own line changed, the anchor of a repeated line also when the lines between it and the nearest unique line of its own block changed or a copy of its text appeared or went away before the nearest unique line on the other side, and the anchor of a blank line also when a neighbouring block moved. An edit tries at most 8 times and starts no new attempt more than 10 seconds after its first attempt found newer text, so one slow attempt, such as a rename on a language server that is still starting, still gets its next attempt; then it fails without writing and says that another process kept writing the file. The edits a native Codemode script has accepted also run again on the current text. A call whose anchor no longer resolves fails alone, the others are saved, and the script result names the failed call. When another process rewrites the file before a Codemode batch's final post-processing, the batch's edits stay saved, post-processing of the newer text is skipped, and the result says so. When a language server answered for an older version of the file, `symbol:` selectors and `lsp_search` results move with their unchanged lines; a declaration whose own lines changed is resolved again, and one the server cannot answer for because the file keeps changing fails with a clear message. An `lsp_search` whose file another process writes while the server answers runs again on the current text. References are asked for at the position the declaration has in the text the server holds, so a reference list stays complete while another process keeps writing the file. A rename through `symbol:…#name` is planned again on the current text when another process writes one of its files while the server answers or before the rename writes it, within the same attempt limit as other edits. The new plan renames the references the server finds in the current text, and a rename whose symbol is gone fails without writing. `ast_search` parses the same bytes it reports on. A `search` registers its anchors from the text it read itself, so a file another process writes in between keeps the anchors of the matches that text holds and the whole result stays usable as an edit source; a matched file that can no longer be read is left out with a notice naming the reason, and a search left with nothing to register fails with that reason instead of showing matches it cannot anchor. An empty list of incoming calls notes that the server's index can miss callers added in the last seconds.

Check the final reported effects after failures or interruptions. An error does not prove rollback: earlier accepted edits can remain, and recursive operations have no atomic undo. Use text undo or Git-change undo deliberately; neither is a script-wide transaction. See [result composition](./structured-results.md) for reference lifetime and recovery.

An omitted path can reuse the last resolved source when it is unambiguous. Supply the path when several resources could be meant.

## Anchors

Anchors are opaque references owned by registered resolvers. The editor does not parse every anchor format itself.

Common built-in forms include:

```text
K7M2QX4                a line, named by its content
scope-begin-K7M2QX4    a structural boundary
SEARCH#19AF:3:line    one result's full line
SEARCH#19AF:3:match   one exact match
SEARCH#19AF:all:line  each unique containing line
SEARCH#19AF:all:match every exact match
CHANGE#5E2C            one current Git change
begin                   the first existing line
end                     the last existing line
```

Snapshot-based anchors are checked against current content. If the source changed, the resolver can reject the anchor and return recovery context instead of editing a different line silently.

A plain exact-text anchor has no stored snapshot identity. If it has no current match, it is missing; if it has several current matches, it is ambiguous. Neither case is stale. Recovery may still return candidate lines without changing those failure semantics.

Anchor plugins can add new formats, map one anchor to several Resources, provide presentation markers for reads, or define constant positions.

### Diff presentation

Mutation diffs keep stable tool and target identity at the head of the card. While generated text streams, a bounded tail contains the active partial row, a continuously moving spinner, and live semantic counts. Existing generated rows count as modified, new generated rows count as added, and removals stay at zero until the mutation result provides execution evidence.

The active preview does not rewrite completed rows above it. Once execution finishes, the card becomes a complete static semantic diff with accurate additions, modifications, removals, context, wrapping, links, omission hints, and expansion behavior. Multi-resource results remain in resource order and use one aggregate count tail. Static current-Git-change views do not animate.

## Post-edit feedback

IDE plugins can add processing after a mutation, including:

- formatting;
- compiler and LSP diagnostics;
- lint checks;
- Git change tracking;
- final rereads and compact diffs.

Configured formatter, linter, and LSP commands find package binaries in the project `node_modules/.bin` before they use the command's configured `PATH` or the Pi process `PATH`. Pi Agent IDE ignores a shipped tool entry when its executable is unavailable. Project and global entries remain explicit commands, so a missing executable in either layer is still reported.

These features do not create new editing tools. They contribute through the IDE and text-editor protocols.

## Typical flow

```text
read ──► anchored snapshot ──► replace / insert / delete
  │                                  │
  └── diagnostics, scopes, changes   └── diff, format, lint, reread

search ──► SEARCH# reference ────────► mutation
```

The intended workflow is to read or search once, keep the returned references in context, and edit against those references. Whether that workflow is better than simpler tools depends on the task and is part of the current evaluation work.

## Deeper contracts

Detailed implementation contracts live next to the components they describe:

- [read behavior](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-read/docs/tools/tool-read.md);
- [read plugin protocol](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-read/docs/plugins/plugin-protocol.md);
- [text-editor plugin protocol](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-text-editor/docs/plugins/plugin-protocol.md);
- [edit pipeline](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-text-editor/docs/plugins/edit-pipeline.md);
- [Resource model](https://github.com/alexshpunt/pi-agent-ide/blob/main/packages/pi-agent-resource/docs/resource.md);
- [text anchor and typed target contracts](https://github.com/alexshpunt/pi-agent-ide/blob/main/packages/pi-agent-text/north-star.md).
