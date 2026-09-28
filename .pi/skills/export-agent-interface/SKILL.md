---
name: export-agent-interface
description: Export the final effective Pi system prompt together with every active tool description, prompt guideline, and parameter schema into one readable review document. Use this whenever the user asks to inspect, review, compare, audit, or show the system prompt or tool schemas; do not recreate temporary capture scripts.
compatibility: Requires the pi-agent-ide development dependencies and a loadable Pi Agent IDE extension entrypoint.
---

# Export the agent interface

Use the repository exporter instead of writing an ad hoc extension or parsing source files. It starts a deterministic real Pi runtime, loads the configured Agent IDE extension, captures the final prompt and tool metadata through Pi's public APIs, normalizes machine-specific paths, and writes one navigable Markdown document.

## Export the default configured interface

From the repository root, run:

```bash
pnpm dev:export-agent-interface
```

The default extension is `src/pi-agent-ide.ts`. The default output is `.tmp/prompt-snapshots/pi-agent-ide.md`.

Open the resulting document with `show_to_user`. Use the returned review feedback as the source for prompt revisions.

## Select tools or another extension

Pass a comma-separated active-tool allowlist when reviewing a focused configuration:

```bash
pnpm dev:export-agent-interface -- \
  --tools read,search,apply \
  --output .tmp/prompt-snapshots/pi-agent-ide-focused.md
```

Pass another entrypoint when reviewing an installed or alternate extension build:

```bash
pnpm dev:export-agent-interface -- \
  --extension path/to/extension.ts \
  --output .tmp/prompt-snapshots/pi-agent-ide.md
```

Use `--cwd <path>` only when the target runtime must resolve project configuration from another workspace.

## What the artifact contains

The Markdown document contains:

1. The exact effective system prompt from `before_agent_start`.
2. The final active tool names.
3. Every active tool's complete description.
4. Tool-specific prompt guidelines.
5. The complete JSON parameter schema.

Treat this generated artifact as review evidence, not repository documentation. Keep it under `.tmp/prompt-snapshots` unless the user explicitly asks for a tracked historical snapshot.

## After changing prompts or schemas

1. Run the exporter again; do not edit the generated Markdown.
2. Read the complete artifact, not only the system-prompt section.
3. Verify that callable contracts remain in tool descriptions and schemas.
4. Verify that workflows live in progressive `docs:` guidance rather than being duplicated in schemas.
5. Present the artifact with `show_to_user` for human review.

The reusable implementation lives in:

- `scripts/dev/export-agent-interface.ts`
- `scripts/dev/capture-agent-interface-extension.ts`
