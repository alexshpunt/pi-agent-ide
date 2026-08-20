# North Star: `pi-agent-read`

## Thesis

`pi-agent-read` is the agent-facing read capability for Pi.

It resolves an opaque source reference through shared `ResourceResolver` contracts, reads the selected Resource, and returns content the agent can consume.

The core is source-neutral. Source recognition, access policy, and source I/O belong to source integrations.

## Shared resource boundary

Resource, resolver, content, and runtime validation contracts come from [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md).

The read core owns an independent resolver registry. It validates resolvers at registration, validates every fulfilled resolution attempt, requires a readable Resource, and validates content returned by `Resource.read()`.

A resolved or failed attempt is terminal. A Resource without `read` fails with `UNSUPPORTED_CAPABILITY`; the core never falls back to another resolver after ownership was established.

## Core ownership

The read core owns:

- the public `read` tool;
- resolver priority and stable selection order;
- the `pre-read`, `read`, and `post-read` pipeline;
- content classification for pipeline selection;
- line and range projection for one text block;
- custom-content projection at the Pi tool-result boundary;
- final single-block text output limits and truncation notices;
- prompt contributions and plugin lifecycle;
- read-specific failures and diagnostics.

## Plugin ownership

A source plugin owns the ResourceResolver and Resources for its domain. It decides which source references it handles and how those sources are read.

A pipeline plugin owns each transformation or presentation handler it registers.

Plugins depend on public `pi-agent-read` and `pi-agent-resource` contracts. The core never imports a concrete source integration.

## Content

Readable Resources return non-empty `AgentContent` from `pi-agent-resource`.

Pi text and image blocks pass through unchanged. A read plugin may transform custom blocks. Any custom block left at the final Pi boundary becomes a text marker in the same position, and its index and kind are recorded in result details.

The core does not serialize custom data or silently drop a block.

## Text projection

A Resource containing exactly one text block is line-addressable. The core may apply `offset` and `limit`, preserve original 1-based line numbers, and render neutral line presentation supplied by plugins.

Mixed content and non-text content are not line-addressable. A range request for such content fails with `UNSUPPORTED_RANGE`.

Final output containing one text block is limited to Pi's standard 2,000 lines or 50 KiB. This limit runs after `post-read` handlers and does not change canonical text in pipeline state.

## Pipeline

```text
pre-read
    -> terminal result
    OR ResourceResolver selection
        -> Resource.read
            -> matching read handlers
                -> text presenters in parallel
                    -> text projection when applicable
                        -> custom-content projection
                            -> post-read
                                -> output limit
                                    -> agent-facing result
```

Resolvers and pipeline handlers are snapshotted for one invocation and run sequentially in deterministic order. Text presenters are also snapshotted, but they run concurrently against the same canonical text and their presentation contributions merge in priority and registration order. Runtime work stays inside the core; `pi.events` carries registration and readiness only.

## Dependency direction

```text
source integration -> pi-agent-resource
source integration -> public pi-agent-read API
pi-agent-read       -> pi-agent-resource
pi-agent-read       -X-> source implementation
```

## Invariants

1. The core loads without a source integration.
2. The core performs no source-specific I/O itself.
3. Resolver selection is deterministic and registry-local.
4. Plugin-supplied shared values are validated before use.
5. A terminal resolver result or capability mismatch never enables fallback.
6. A successful Resource read returns non-empty AgentContent.
7. Text and image blocks keep their Pi representations.
8. Remaining custom blocks become explicit markers, never implicit serialization.
9. Canonical source text remains separate from plugin-provided presentation.
10. Final single-block text output is bounded without changing canonical pipeline text.
11. No process-global read registry is required.
