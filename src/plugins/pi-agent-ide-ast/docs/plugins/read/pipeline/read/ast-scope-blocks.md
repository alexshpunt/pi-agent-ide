# Read-stage plugin: AST scope blocks

## Purpose

The `ast-scope-blocks` plugin identifies structural blocks in source text and attaches begin/end markers to the corresponding lines. It helps the agent understand nesting and provides stable locations for later anchored edits.

It is an independently loaded Pi extension. It enriches normal filesystem reads and owns the `ast:` source resolver.

The `ast` view adds scope markers to filesystem text. Its read handler maps source positions for explicit `ast:` reads. Its post-read handler handles automatic overflow outlines and adds missing closing scope lines.

The generated prompt explains these modes and how to read exact source text after an overview.

## Automatic overflow overview

When the requested filesystem text exceeds Pi's normal output buffer, the plugin tries a compact outline of the whole read snapshot. It keeps original line numbers, collapses bodies and starts at 12 syntax-tree levels. If the rendered overview still exceeds the buffer, it lowers the depth one level at a time and stops at the first fit. At depth zero only file-level information remains. It parses once and never rereads the file for these attempts.

Small windows stay exact, even in large files. Unsupported files, invalid syntax and unavailable parsers keep normal truncation. The overview is labelled as compressed text; read a small source range when exact implementation text is needed. This mode does not restore the removed `lines` view or change explicit `ast:` depth.

The prompt recommends explicit `ast:<path>` when the agent needs structure to locate a declaration or choose a region. It does not require a structural read when the location or a sufficient edit anchor is already known.

## Outline source

Use `read` with `ast:<path>` to read a compressed outline of one source file. The path may be relative to the session directory or absolute. `ast:` does not accept a symbol fragment.

The result keeps declarations, signatures, imports, and structural boundaries while collapsing implementation bodies and data values. Every visible source line keeps its original line hash and available scope markers, so it can be used in later edit calls.

Malformed sources, unsupported file types, missing files, and unavailable parsers return a failed `read` result. They never fall back to the filesystem resolver.

## Scope model

A scope is a source range with a start line, an end line, and stable markers:

```ts
interface TextScope {
  startLine: number;
  endLine: number;
  beginAnchor: TextAnchor;
  endScopeAnchor: TextAnchor;
}
```

The AST provider may identify classes, functions, methods, blocks, declarations, markup elements, or other language-specific scopes. The plugin must use the provider's registered language support and must not assume that every text source is parseable code.

Markers are attached to the source lines that define the scope boundaries:

```text
1#ABCD|export function main() {  <!-- scope-begin-ABCD -->
2#55EF|    work();
3#12AA|}  <!-- scope-end-12AA -->
```

The marker format is part of the anchor protocol. Scope markers must remain distinguishable from ordinary line anchors and must preserve occurrence information when two scopes have the same hash.

## Processing rules

The plugin:

1. checks whether the resolved source has a supported language mapping;
2. parses the complete resolved source snapshot when possible;
3. obtains scopes from the language-specific provider or a generic fallback;
4. maps scope boundaries to source line numbers;
5. attaches begin/end markers and opening-to-closing relationships to the full snapshot;
6. after normal read projection, checks which opening markers are visible in the result;
7. adds every missing closing source line to that result as structural context.

Nested scopes are retained when they provide useful structure. Redundant duplicate boundaries may be removed by the provider, but the plugin must not collapse distinct scopes merely to shorten output.

When a range selects only part of a file, an opening marker makes its matching closing source line part of the same result. The added line keeps its original line number, content, and scope-end marker. No unrelated source lines are injected.

## Failure behavior

Scope enrichment is best effort by default:

- unsupported languages return the original text without scope markers;
- parser-unavailable results return the original text without scope markers;
- syntax errors may produce partial scopes or an unchanged result;
- provider failures are reported in plugin metadata and do not destroy readable source text.

A strict structural-read policy can be implemented by another plugin. This plugin itself should not turn missing AST support into a failed file read.

## Metadata coexistence

Scope markers remain line metadata. The AST plugin preserves existing line presentation and appends its own markers, so text anchors and later diagnostic annotations can coexist.

## Non-goals

The plugin does not:

- claim ordinary filesystem paths or `file:` URLs;
- query LSP diagnostics;
- change source text or formatting;
- enforce stale-anchor policy;
- block edits when a scope changes.
