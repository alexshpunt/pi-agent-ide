# Tools and workflow

Pi Agent IDE explores a small tool surface for coding agents. The goal is to keep common operations easy to call while letting resolvers and plugins handle source-specific work.

The project is experimental. The behavior below describes the current implementation, not a performance guarantee.

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

## Search

`search` gives the agent one discovery interface. Built-in resolvers cover:

- file and text search;
- language-aware and structural search;
- semantic search through QMD;
- web search.

A resolver decides whether it understands a query. The first successful resolver returns the result. Search plugins can add new query forms without adding another agent tool.

Search results can expose reusable `SEARCH#...` references. A later edit can target one result or every selected result without asking the agent to translate search output into line numbers.

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

Path inheritance lets a later mutation reuse the most recently resolved Resource when the operation is unambiguous. Batched tool calls use the same mutation contracts as direct calls.

## Anchors

Anchors are opaque references owned by registered resolvers. The editor does not parse every anchor format itself.

Common built-in forms include:

```text
12#A4F0                 a line from a specific snapshot
scope-begin-7C21       a structural boundary
SEARCH#19AF:3          one search result
SEARCH#19AF:all        all results in a search selection
CHANGE#5E2C            one current Git change
begin                   the first existing line
end                     the last existing line
```

Snapshot-based anchors are checked against current content. If the source changed, the resolver can reject the anchor and return recovery context instead of editing a different line silently.

Anchor plugins can add new formats, map one anchor to several Resources, provide presentation markers for reads, or define constant positions.

## Post-edit feedback

IDE plugins can add processing after a mutation, including:

- formatting;
- compiler and LSP diagnostics;
- lint checks;
- Git change tracking;
- final rereads and compact diffs.

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
- [Resource model](https://github.com/alexshpunt/pi-agent-ide/blob/main/packages/pi-agent-resource/docs/resource.md).
