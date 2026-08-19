# Pre-read plugin: outline

## Purpose

The `outline` plugin preserves the current agent-friendly read behavior for source-code files: when the agent requests a plain code file without a line range, the plugin returns a compressed AST outline instead of the complete source text.

This is a `pre-read` plugin because it selects an alternate textual representation before ordinary read projection. It is an early short-circuit, not a filesystem resolver. Source access remains delegated to the configured resolver and AST provider.

## Activation predicate

The plugin activates only when all of the following are true:

- the request resolves to a local source file through an installed filesystem resolver;
- the file extension is supported by the configured AST provider;
- `offset` is absent;
- `limit` is absent.

The presence of either property disables outline mode, even when its value would otherwise mean “read from the beginning”:

```json
{ "path": "src/main.ts" }
```

uses the compressed outline, while both of these request source content:

```json
{ "path": "src/main.ts", "offset": 1 }
{ "path": "src/main.ts", "limit": 80 }
```

This exact presence check preserves the current `read` behavior. A request with an explicit range is an intentional request for source text and must not be silently replaced by an outline.

The plugin does not activate for:

- HTTP, URL, symbol, or internal references;
- directories;
- unsupported source-code extensions;
- requests containing `offset` or `limit`.

## Processing

When activated, the plugin:

1. requests the source snapshot through the resolver registry, using the filesystem resolver for the local file;
2. asks the AST provider to parse the source file;
3. projects declarations and relevant structure while eliding implementation bodies;
4. preserves source line references for rendered lines;
5. adds scope block markers where the AST provider identifies them;
6. returns an outline representation as the pre-resolved text state.

The output is a compact source view, not a summary written by a language model. It should retain enough declaration names, signatures, headings, and line locations for the agent to decide which targeted read to request next.

A conceptual result may look like:

```text
## file: src/service.ts
Lines: 1-42 of 180

  1#AB12|export class Service { <!-- scope-begin-AB12 -->
  2#CDEF|    constructor(private readonly db: Database);
  3#9012|    async load(id: string): Promise<Item> { … }
 42#77AA|} <!-- scope-end-77AA -->
```

The exact outline syntax belongs to the AST provider, but the result must remain plain text with inspectable source locations and anchors wherever a rendered line maps to the source.

## Parser and outline failures

The plugin should fail soft for source-introspection failures:

- if no parser is available, return a source-view fallback or a structured outline-unavailable block;
- if the file is syntactically invalid, return the best outline the parser can produce or a structured failure;
- if the source resolver fails, propagate the resolver failure;
- never fabricate declarations or silently claim that a complete source read was performed.

The plugin may include a diagnostic such as `OUTLINE_UNAVAILABLE`, but it must preserve the original source reference and explain whether the parser or the source was unavailable.

## Pipeline behavior

The plugin may return a pre-resolved textual outline state, which means the normal resolver-selection/read step is not repeated. It must not prevent later `read` and `post-read` stages from running unless the host explicitly configures that behavior. It may choose `continue` to let the outline flow through later processors, or terminal `return` to deliver it immediately.

```text
pre-read outline
    -> read processors
    -> common line/anchor projection
    -> post-read processors
```

This allows later plugins to add hints or apply output limits consistently to both outlines and ordinary source reads.

If a text processor changes the outline's rendered content, anchors must be regenerated for the changed lines or the affected content must be marked display-only.

## Non-goals

The outline plugin does not:

- run for explicit `offset`/`limit` reads;
- provide symbol lookup as a separate public schema field;
- enforce path permissions or a project root;
- format the complete source file;
- edit the file;
- guarantee that every language has an AST parser;
- replace targeted reads when the agent explicitly asks for source lines.
