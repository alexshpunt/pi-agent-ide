# `read`

## Purpose

`read` is the agent-facing input tool provided by `pi-agent-read`.

It resolves an opaque source reference to a shared Resource, invokes `Resource.read()`, and returns Pi text and image content. Source-specific I/O is not implemented by this package.

## Tool identity

```text
tool definition name: read
plugin API:          flat ReadPluginApi
prompt section:      Read Extensions
implementation file: tool-read.ts
```

The real ToolDefinition is the only owner of the `read` tool ID. Pipeline stage names are not tool IDs.

## Request

```ts
interface ReadRequest {
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly views?: readonly string[];
}
```

The same per-invocation context is passed to every pipeline handler:

```ts
interface ReadPipelineContext {
  readonly request: ReadRequest;
  readonly resolverContext: ResourceResolverContext;
  readonly state?: ReadState;
  readonly result?: ReadToolResult;
}
```

`path` is an opaque source reference. Core passes it unchanged to resolver attempts. An omitted or empty path returns `INVALID_REQUEST`.

## Typed target reads

Before normal Resource resolution, core offers the complete `path` value to registered `TextTargetResolver` implementations. A resolver may return ordered targets with Resource sources and half-open character ranges. When `ranges` is omitted, read synthesizes a first-line chunk; the editor treats the same omission as source scope. The resolver owns the value's syntax; core validates the result and does not parse values such as `SEARCH#...`.

For every target range, core runs the normal Resource and read pipeline, then projects an independent chunk whose origin is the range's containing line. The request's `offset` and `limit` apply separately to each chunk. Without an explicit `limit`, the range supplies the chunk's natural line count, with at least one line. Read joins chunks in resolver order and then enforces the aggregate 2,000-line or 50 KiB limit.

A typed target rejection, failed callback, malformed result, missing Resource, pipeline error, or unsupported content fails the complete read. Core does not return the chunks completed before that failure.

The built-in text search resolver exposes `SEARCH#HASH:N:line`, `SEARCH#HASH:N:match`, `SEARCH#HASH:all:line`, and `SEARCH#HASH:all:match` this way. Both `:line` and `:match` reads start at the containing line; the mode controls the selected edit range, not partial-line read rendering.

## Anchored reads

A `path#fragment` suffix turns the read into an anchored read. Core first tries the whole string as a resource; only when no resolver handles it does it split at the first `#` and treat the tail as an anchor value. A real file whose name contains `#` therefore always reads whole.

Registered fragment resolvers translate the fragment into one absolute origin line. The pi-agent-text-editor core contributes a resolver backed by the shared anchor registry, so every anchor kind that works for edits also works here, with the same strictness: missing or ambiguous anchors fail with candidate lines instead of guessing.

Request coordinates are relative to the origin:

- `offset: 1` (default), `offset: 0`, and an omitted offset all start the window at the origin line.
- A positive offset greater than one moves the window forward from the origin; a negative offset widens it upward, clamped at line one.
- `limit` caps the window as usual; output keeps absolute line numbers and real line hashes so later edit anchors stay valid.
- Continuation hints state the next offset in request coordinates, ready to copy into the same anchored request.

Anchored reads on non-textual content return `UNSUPPORTED_RANGE`; an anchor nobody resolves returns `NO_FRAGMENT_RESOLVER`.

For an unanchored text block, `offset` is a 1-based line offset. Without an anchor fragment, a negative offset starts that many lines from the end, so `offset: -20` reads the last 20 lines. `limit` caps the number of lines returned from that resolved start line.

A range on mixed or non-text content returns `UNSUPPORTED_RANGE`.

## Output limits

A result containing one text block is limited to the first 2,000 rendered lines or 50 KiB, whichever is reached first. Core applies this limit after `post-read` handlers and to textual terminal results returned by earlier stages.

Automatic truncation keeps complete lines, adds a continuation notice, and records Pi's `TruncationResult` in `ReadResultDetails.truncation`. If the selected resolver enables `preserveTruncatedOutput`, the notice also includes a `temp:<id>` source for the complete final text. If the first line alone exceeds 50 KiB, the result contains only a notice instead of partial source text.

An explicit `limit` that stops before the end also reports the remaining line count and next `offset`. Mixed and non-text content is unchanged.

A `temp:<id>` source supports `offset` and `limit`. Read returns the stored final text without handlers or text presenters. Reading it resets its five-minute inactivity period.

## Resolver registration

Read plugins register the shared resolver contract from `pi-agent-resource`:

```ts
interface ResourceResolverRegistration {
  readonly resolver: ResourceResolver;
  readonly priority?: number;
}
```

The read core validates the resolver before registration. Resolver IDs are unique inside one read core. `any` remains reserved for handler matching.

Lower priority runs first. Equal priority preserves registration order. The registry is snapshotted for each invocation.

Plugins may also register the source-neutral typed target contract from `pi-agent-text`:

```ts
interface TextTargetResolverRegistration {
  readonly resolver: TextTargetResolver;
  readonly priority?: number;
}
```

Target resolvers are ordered and snapshotted independently from Resource resolvers. Only `not-handled` continues to the next target resolver.

## Selection

Resolver selection is sequential:

1. run `pre-read` handlers;
2. take the effective source from the resulting request;
3. call each `ResourceResolver.tryResolve(source, { cwd, signal })` in sorted order;
4. validate every fulfilled value with `isResourceResolutionAttempt`;
5. continue only after `not-handled`;
6. stop after `resolved`, `failed`, a thrown callback, or an invalid fulfilled value;
7. return `NO_RESOLVER` if every resolver returns `not-handled`.

A thrown or rejected resolver call becomes `RESOLVE_FAILED`. An explicit failed attempt does the same. Both keep the original error as the cause, and a non-empty `Error.message` is appended to the agent-facing failure text.

Invalid fulfilled output becomes `INVALID_RESOLVER_RESULT`. It is terminal and never enables fallback.

## Resource read

After a resolved attempt, core uses the returned Resource from that exact attempt.

The Resource must expose `read`. A write-only Resource produces terminal `UNSUPPORTED_CAPABILITY`; core does not try another resolver.

Core invokes:

```ts
const content = await resource.read({ signal });
```

A rejected read becomes `READ_FAILED` with canonical Resource source and resolver context. A non-empty `Error.message` is appended to the agent-facing failure text while the original error remains the cause. Fulfilled content is checked with `isAgentContent`; malformed content becomes `INVALID_RESOURCE_CONTENT`.

Core uses `resource.source` as the canonical source for later state and diagnostics.

## Content state

Validated AgentContent becomes a ReadState with:

- `source` from the Resource;
- `resolvedBy` from the selected resolver ID;
- `contentKind` derived by core;
- the original non-empty AgentContent.

`contentKind` is `text` only for exactly one TextContent block. Every other valid content list is `other`.

Resolvers cannot supply `resolvedBy` or `contentKind`.

## Text projection

For one text block, core splits canonical text into source lines before read handlers and text presenters run. Each line keeps its 1-based source line number and line ending.

A read handler may change pipeline state before presentation. Text presenters only attach neutral prefixes, suffixes, rows, markers, and metadata. They must preserve the canonical source, content, line count, line numbers, line content, and line endings.

Core starts the requested text presenters concurrently against the same text snapshot. When one requested view declares that it includes another, core skips the included view. After all remaining presenters finish, core merges their contributions in priority order, then registration order, before applying the requested range. An empty text Resource remains one text block with an empty string. A range that selects no lines also returns one empty text block.

## Custom-content projection

Read handlers may understand and transform CustomContent before the final result is built.

Each remaining custom block is replaced in the same position by:

```text
[unsupported_content_block kind=<kind> index=<index>]
```

Result details include the source-order list:

```ts
interface UnsupportedContentBlockDetail {
  readonly index: number;
  readonly kind: string;
}
```

Custom data is never copied into the marker or details. A result containing only generated markers is successful.

## TUI result presentation

A resolver registration may provide an optional Pi `renderResult` function. Successful projection records the selected resolver ID in `ReadResultDetails.resolvedBy`. The read tool uses that saved ID to select the same renderer when Pi first draws the result or restores it from a session. Rendering never reads the source again and never changes the content sent to the agent.

The standard renderer has source, Markdown, and code-view modes. It shows at most 12 content rows while collapsed and all saved rows while expanded. A clipped panel shows the configured `app.tools.expand` key. Source integrations choose the mode for the content they own.

For structured text results, the TUI renders the saved text projection. With no requested views, this is the canonical text. Requested views also appear in the panel, including line numbers, anchors, diagnostic annotations, added rows, change markers, and AST scope markers. A requested view is omitted when another requested view declares that it includes its complete presentation. Ranges and truncation appear as short user-facing labels instead of agent continuation instructions.

The result content, canonical lines, resolver ID, line range, and truncation details are serializable session data. The expanded flag remains Pi's global current tool-output mode and is not stored per result. If a restored resolver renderer is unavailable, the tool uses the source-neutral fallback.

## Pipeline

```text
one ReadPipelineContext
    -> pre-read handlers
    -> resolver selection and Resource.read
    -> read handlers
    -> text presenters in parallel
    -> text projection when applicable
    -> custom-content projection
    -> post-read handlers
    -> tool result
```

The same context object flows through every stage. It contains the request and resolver context, and gains the resolved `state` and projected `result` as the pipeline advances. A handler may replace any available value by returning a new context.

A read handler matches `resolvedBy` and `contentKind`. `any` is the explicit wildcard.

Every handler returns:

```ts
type ReadStageOutcome =
  | { readonly kind: "continue"; readonly context: ReadPipelineContext }
  | { readonly kind: "return"; readonly result: ReadToolResult };
```

Pipeline handlers run sequentially in registration order because each handler may replace the context or return a terminal result. A terminal return stops later work. A thrown handler becomes `PIPELINE_FAILED` with plugin and stage context. Text presenters use the separate parallel behavior described above.

## Failures

The implemented ReadFailure codes are:

```ts
type ReadFailureCode =
  | "FRAGMENT_FAILED"
  | "INVALID_REQUEST"
  | "INVALID_RESOLVER_RESULT"
  | "INVALID_RESOURCE_CONTENT"
  | "NO_FRAGMENT_RESOLVER"
  | "NO_RESOLVER"
  | "PIPELINE_FAILED"
  | "READ_FAILED"
  | "RESOLVE_FAILED"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_CONTENT"
  | "UNSUPPORTED_RANGE";
```

Failures retain source, resolver, plugin, stage, and cause fields when that context exists.

## Non-goals

`read` does not:

- implement local filesystem, URL, symbol, or application source access;
- write Resources;
- enforce source authorization or a project root;
- serialize CustomContent data;
- apply text ranges to non-text content;
- perform OCR, transcription, document conversion, or transcoding;
- invoke editor, LSP, AST, formatting, or UI behavior without a plugin.
