# Tools and workflow

Pi Agent IDE explores a small tool surface for coding agents. The goal is to keep common operations easy to call while letting resolvers and plugins handle source-specific work.

The project is experimental. The behavior below describes the current implementation, not a performance guarantee.

## Resource references

Tool source fields take one complete resource reference. A filesystem path is the common case, but it is not the only kind of reference. Depending on the tool and loaded resolvers, a reference may name a file, URL, protocol source, temporary result, or a typed text selection.

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

## Read

`read` resolves a source and returns agent-ready content. Built-in resolvers currently cover:

- local text files and directories;
- images and PDFs;
- HTTP and HTTPS resources;
- HTML converted to readable Markdown;
- AST-aware code views;
- LSP diagnostics, symbols, references, and call graphs.

A read result may include anchors, diagnostics, Git changes, or structural markers. Large text results are bounded, and supported resolvers can retain the complete output in a temporary resource.

Read sources are not assumed to be writable. The read and text-editor cores keep separate resolver registries so a derived view cannot be edited by accident.

HTTP(S) pages use a fast direct request first. Failed requests (including HTTP 403 and timeouts), failed HTML conversion, and empty HTML automatically trigger one retry through local Chrome or Chromium within the same `read` call. The browser gets a fresh timeout; caller cancellation stops both attempts. If the browser also fails or is not installed, the read reports both failures. Successful non-HTML reads and non-HTML conversion errors keep their normal behavior. Browser rendering removes hidden elements before the same HTML-to-Markdown conversion runs.

Browser reads discover `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser` on `PATH` and in common Linux locations. Set `PI_AGENT_IDE_BROWSER_PATH` to use another executable. Missing browser support returns a normal read failure and `/pi-agent-ide-doctor` reports it as an optional warning. Browser reads execute page JavaScript. When Pi runs as root, Chromium is launched without its process sandbox; only open sources you trust in that mode.

When `path` is a typed text resource, `read` returns one independent chunk for each selected range, in resolver order. Each chunk starts at the range's containing line. `offset` and `limit` are applied to every chunk, not across the combined result. The chunks are then joined and the normal aggregate limit of 2,000 lines or 50 KiB is applied.

### Diagnostic completion

Edits save before background diagnostics finish. The next model context receives changed counts and statuses; explicit `diagnostics:<path>` reads and the diagnostics view return details.

LSP reads prefer standard pull reports. Servers that advertise a supported completed-request command can use an adapter; TypeScript language server uses one adapter for both TypeScript and JavaScript. Adapter selection uses server capabilities, not language names. All requests remain tied to the synchronized document revision and are canceled when it becomes stale.

Other push-only servers return a `snapshot`: the latest publication, with no promise that every check has finished. This also applies to versioned pushes. An empty snapshot is not a completed clean report. For example, clangd publications remain usable C++ snapshots without invoking TypeScript commands. Later pushes from pull-capable or adapter-backed servers trigger a fresh completed request rather than replacing it with a partial publication.

## Search

`search` gives the agent one discovery interface. Built-in resolvers cover:

- file and text search;
- language-aware and structural search;

A resolver decides whether it understands a query. The first successful resolver returns the result. Search plugins can add new query forms without adding another agent tool.

Local text search tries literal terms first. If there are no matches, it retries unquoted terms as regex. If that also finds nothing, an ordinary multi-word query falls back to separate words. Each fallback is reported. Invalid optional regex is skipped, while I/O errors, cancellation, and regex runtime errors stay errors. `regex:<pattern>` forces regex-only matching and reports invalid patterns.

Boolean queries keep their conditions across literal and regex attempts. They support uppercase `AND`, `OR`, infix `NOT`, `||`, and space-separated `|`. Adjacent terms imply `AND`; `AND` and `NOT` bind more tightly than `OR`. Parentheses containing Boolean operators group conditions. Regex groups, classes, and escapes stay inside terms: `(?:foo|bar)\d+ AND "keep.me" NOT ignored`. An unspaced `foo|bar` is searched as literal text first, then as regex alternatives. Single or double quotes keep a term literal in every attempt. Quoted and Boolean queries never fall back to separate words. Invalid Boolean expressions report the source column and expected syntax.

Empty protocol queries such as `symbols:` and unhandled prefixes such as `unknown:needle` search their original text, including the prefix. The tool reports this fallback. Nonempty installed protocols keep their specialized behavior; service errors, timeouts, and successful protocol searches with no results do not launch local text search. Plugins mark a local fallback resolver with `fallback: true`; these resolvers run after specialists regardless of numeric priority and receive empty protocol queries directly.

A complete search call times out after 30 seconds by default, including resolver work and result formatting. The timeout cancels the active resolver and tells the agent to retry with a smaller `path` scope. Global and project `search.json` files can change or disable the timeout as described in [Configuration](./configuration.md#search-timeout).

Local text and regex results can expose four reusable forms:

- `SEARCH#HASH:N:line` selects result `N` as a whole line;
- `SEARCH#HASH:N:match` selects the exact match for result `N`;
- `SEARCH#HASH:all:line` selects each unique containing line once;
- `SEARCH#HASH:all:match` selects every exact match.

Every response that includes these values includes an `Anchors:` syntax legend after any fallback notices. Bare `SEARCH#HASH:N` and `SEARCH#HASH:all` values are invalid and are not displayed.

These values are both edit anchors and typed text resources. `read` and mutation `path` fields accept each complete `SEARCH#...` value directly; no filesystem path is added before or around it. The text search resolver turns them into ordered Resource sources and character ranges; consumers use that typed result and do not parse the `SEARCH#` string themselves.

A `:line` range includes its LF or CRLF line ending. A whole-line replacement preserves that separator when the replacement text does not provide one. Insertion happens after the line by default and before it when `before: true`. A final line without a line ending selects through EOF and stays without a trailing separator when replaced, unless the replacement text provides a line ending. Whole-line deletion removes the preceding separator when that is needed to remove a final no-LF line cleanly. Adjacent whole-line deletions are coalesced. A `:match` range contains only the matched characters, so deleting it keeps surrounding text and line endings.

Per-result forms keep the search-time snapshot and fail as stale after their matched file changes. Complete `:all` forms rerun the original search recipe when a matched file changes, then select the current complete result set. Limited or otherwise incomplete searches omit the `:all` forms. A forged `:all` value for an incomplete search is rejected.

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

A plain filesystem `path` names the Resource in which anchors are resolved. It is a scope, not an instruction to mutate the whole file. When an explicit anchor selects several Resources, a matching plain path limits the operation to that Resource; omitting the path applies it to the complete selection. A path outside the selection is rejected. `replace`, `delete`, and `insert` still need an anchor unless `path` is a typed text resource that already supplies ranges.

A typed path applies the operation to its selected ranges:

- `replace` replaces every range;
- `delete` deletes every range;
- `insert` inserts after every range by default, or before every range with `before: true`;
- `copy` and `move` may use one selected range as their source span.

An explicit compatible anchor can be combined with a typed path. The editor resolves it in every selected Resource and unions its range with the path ranges. Position anchors such as `begin`, `end`, and line hashes contribute their natural whole-line range. Different Resource sets, incompatible selection shapes, overlaps, reversed spans, ambiguous values, and stale values are rejected before any write.

When both `start` and `end` are supplied, they define one natural span from the start selection's left edge through the end selection's right edge. They must resolve to one Resource and one usable range at each endpoint. Without `end`, a search selection can apply independently to several ranges and Resources.

`copy` and `move` always need a destination selection. `target` is only the destination Resource scope and defaults to the source scope. `targetStart`, or a typed `target` that supplies its range, selects the destination. Without `targetEnd`, content is inserted after that selection. With `targetEnd`, the inclusive natural destination span is replaced.

The editor resolves and reads every Resource, resolves every anchor, applies every change in memory, and runs guards before the first write. A failure in those steps writes nothing. If a later Resource write fails, the editor attempts to restore every Resource already touched and reports any rollback failure. There is no silent partial success.

Path inheritance lets a later mutation reuse the most recently resolved Resource when the operation is unambiguous. Batched tool calls use the same mutation contracts as direct calls.

## Anchors

Anchors are opaque references owned by registered resolvers. The editor does not parse every anchor format itself.

Common built-in forms include:

```text
12#A4F0                 a line from a specific snapshot
scope-begin-7C21       a structural boundary
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
