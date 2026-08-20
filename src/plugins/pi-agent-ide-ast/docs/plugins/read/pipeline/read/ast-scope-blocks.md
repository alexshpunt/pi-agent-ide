# Read-stage plugin: AST scope blocks

## Purpose

The `ast-scope-blocks` plugin identifies structural blocks in source text and attaches begin/end markers to the corresponding lines. It helps the agent understand nesting and provides stable locations for later anchored edits.

It is an independently loaded Pi extension. It enriches normal filesystem reads and owns the `ast:` source resolver.

Its `read` handler is registered with this selector:

```ts
when: {
    resolvedBy: "filesystem",
    contentKind: "text",
}
```

Core invokes it only for decoded text returned by the filesystem resolver and never for another resolver or non-text content. The plugin preserves the resolved text and adds structural metadata.

Its prompt contribution explains both behaviors and advertises `ast:<path>`.

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
