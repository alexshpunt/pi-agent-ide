# Read-stage plugin: LSP inline hints

## Purpose

The `lsp-inline-hints` plugin enriches resolved source text with language-server information that helps an agent understand the file without changing the source content.

It is an independently loaded Pi extension and owns no source resolver.

Its `read` handler is registered with this exact selector:

```ts
when: {
    resolvedBy: "filesystem",
    contentKind: "text",
}
```

Core therefore invokes it only after the filesystem resolver has returned decoded text. Results from other resolvers and non-text filesystem results never enter this handler.

Its own prompt contribution is `Adds language-server hints to local source text.`

## Supported input

For matched filesystem text, the plugin runs only when the source identifies a language-aware local document and an LSP provider is available. It may use:

- the effective filesystem path from resolver metadata;
- the original opaque source reference;
- `contentType` or a language identifier;
- the complete resolved text.

Non-code files and documents without an available language server continue unchanged.

## Hint model

A hint is line-oriented metadata attached to a source line rather than a mutation of the source text:

```ts
interface InlineHint {
  line: number;
  column?: number;
  severity?: "error" | "warning" | "info" | "hint";
  code?: string;
  message: string;
  source?: string;
}
```

The plugin may obtain diagnostics, type information, inlay hints, or other LSP messages, but the result must be converted to a compact agent-readable hint. Hints should retain line and optional column information so they remain useful after range selection.

A renderer may display them as inline comments, for example:

```text
12#ABCD|const value = config.timeout;  <!-- lsp: type is number | TS2322 -->
```

The exact comment syntax is a rendering concern. Structured hint data must remain available independently of the formatted text.

## Processing rules

The plugin:

1. checks whether the resolved source can be mapped to an LSP document;
2. requests relevant diagnostics or inline information using the invocation signal;
3. maps returned positions to the resolved text lines;
4. attaches hints to the textual read state;
5. leaves source content unchanged;
6. lets common projection and rendering expose the hints with the selected lines.

Hints must not change line content or previously attached metadata. They are annotations on the returned representation, not edits to the resolved text.

The plugin should deduplicate identical hints and keep the output bounded. A large diagnostic set should be summarized or capped rather than overwhelming the agent context.

## Failure behavior

LSP enrichment is best effort by default:

- unavailable servers produce an unchanged read result;
- timeouts and cancellation preserve the source text and report optional metadata;
- malformed LSP responses are recorded as plugin diagnostics and do not corrupt line content;
- resolver failures remain resolver failures and are not hidden by the plugin.

A host may configure strict LSP mode as a separate policy, but the neutral plugin must not make a successful textual read depend on language-server availability.

## Metadata coexistence

LSP hints remain independent line annotations. The final formatter is responsible for stable ordering when other handlers attach metadata to the same line.

## Non-goals

The plugin does not:

- modify files;
- run formatters or linters unless exposed through a separate provider;
- block reads because diagnostics exist;
- infer a language from arbitrary text without a configured mapping;
- expose the full raw LSP protocol to the agent.
