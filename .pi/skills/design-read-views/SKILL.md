---
name: design-read-views
description: Design or change Pi Agent IDE Read views, especially parameterized views such as jq filters, image settings, sequences, annotations, and source-specific presentations. Use whenever work adds view syntax, parses values inside `views`, transforms Read content, or changes how views compose with offset, limit, rendering, docs, or progressive guidance.
compatibility: Requires the pi-agent-read plugin APIs and real-Pi integration tests.
---

# Design Read views

Treat `views` as a small source-specific presentation language. Keep the top-level Read schema stable when a capability naturally belongs to one source or presentation.

## Choose the right extension point

- Use `api.addView()` with a presenter when the view only annotates existing text lines.
- Use a read-stage handler when the view transforms canonical textual content.
- Use a pre-read handler when the view changes how a source is acquired or returns native content such as images.
- Register the base view name. Read normalizes `name:parameters` to `name` for routing and preserves the complete string in `context.request.views`.
- Do not make a presenter change canonical text. Presentation-only validation rejects that behavior.

Read the public contracts before implementation:

- `src/extensions/pi-agent-read/src/api/tools/read.ts`
- `src/extensions/pi-agent-read/src/core/tools/tool-read.ts`
- `src/extensions/pi-agent-read/src/core/tools/read/read-result.ts`

Use `src/plugins/pi-agent-ide-vision/` as the main example of named parameter parsing and native output. Use `src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-jq/` as the example of textual transformation.

## Define syntax deliberately

- Keep one stable base name before the first colon.
- Parse the remaining string according to the embedded language instead of splitting blindly on commas or spaces.
- Reject empty, duplicate, ambiguous, or unsupported forms with an actionable error.
- Decide whether the view composes with other views. Reject combinations when annotations or coordinates would become misleading.
- Keep source-specific arguments inside the view string. Add top-level Read parameters only when their meaning is truly shared by every source.

## Preserve Read contracts

- Apply `offset` and `limit` to the final textual presentation unless the content kind has an explicit source-specific contract.
- Keep transformed output inside shared output budgets and continuation behavior.
- Preserve complete oversized output through the shared temporary-resource mechanism when follow-up access matters.
- Keep script data honest. Do not present transformed data as original source coordinates.
- Return structured Read failures rather than raw process errors.

## Run external processors safely

- Start executables directly with an argument array. Never build a shell command.
- Send resource content through standard input instead of exposing arbitrary source paths.
- Bound runtime, stdout, and stderr; honor cancellation and terminate the child.
- Minimize inherited environment data.
- Disable module, include, or additional-file mechanisms when they are outside the view contract.
- Report missing runtime dependencies through Doctor as well as the Read failure.

## Make the capability discoverable

- Add one concise `api.describe()` entry that states callable syntax.
- Put workflows and examples in a packaged guide under `docs/agent-guides/`.
- Register a precise progressive-documentation trigger. Match parameterized views by view prefix rather than attaching a guide to every Read.
- Keep tool descriptions, schemas, guidelines, and progressive docs in their owning layers.

## Verify both surfaces

1. Unit-test parsing, validation, cancellation, limits, and errors.
2. Use a real-Pi integration test for registration, transformation, pagination, and documentation attachment.
3. Export the effective agent interface with `pnpm dev:export-agent-interface` and inspect the final description and schema.
4. Reload Pi after extension changes and call the real Read tool.
5. Inspect the TUI when the new view changes visible rendering.
6. Run format, lint, typecheck, catalog, boundaries, package, and focused tests.
