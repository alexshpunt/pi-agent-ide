# Text edit pipeline

## Purpose

`TextEditorCore.executeEdit()` composes editor plugins around a caller-provided operation. The platform does not implement the operation itself.

Source-backed text operations use `TextEditorCore.editText()` inside that caller-owned operation. `editText()` resolves, reads, validates, and writes a shared Resource; `executeEdit()` owns only pipeline composition.

## Stages

```text
text-pre-edit
    -> caller-provided operation
        -> text-edit
            -> text-post-edit
```

- `text-pre-edit` transforms normalized request state before mutation.
- the operation receives the final pre-edit state and returns its result;
- `text-edit` transforms request state plus operation result;
- `text-post-edit` transforms the final state before agent-facing mapping.

## State

```ts
interface TextPreEditState<Input = unknown> {
  readonly cwd: string;
  readonly input: Input;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface TextEditState<Input = unknown, Result = unknown> extends TextPreEditState<Input> {
  readonly result: Result;
}
```

Each handler returns the complete state for the next handler. Core does not merge plugin metadata.

## Resource operation

The source-neutral mutation boundary is:

```ts
interface TextMutationResult<Result> {
  readonly text: string;
  readonly result: Result;
}

core.editText(source, { cwd, signal }, async (text, resolveAnchor) => {
  const line = await resolveAnchor(input.anchor);
  return {
    text: mutate(text, line),
    result,
  };
});
```

`editText()` requires exactly one text block and a Resource with both read and write callbacks. It writes through the same Resource object returned by resolution.

`resolveAnchor` uses one ordered resolver snapshot and the exact text passed to the operation. It returns only a line number.

Resource failures become `TextResourceEditFailure` outcomes. A thrown caller mutation is not caught because that operation owns its own failure contract.

## Mutation plans and guards

`editTexts()` prepares every declared Resource, then passes each Resource's changes to the local ChangeSet engine. The engine applies ranges against the original document once and returns the final text plus the actual changed ranges.

Core builds the mutation plan from that engine result. The plan contains each original document, final document, existence state, and applied changes. Committed mutation guards run in registration order before the first write. A guard may accept the plan or return a structured, not-applied rejection. A thrown guard is a plugin failure; an expected rejection uses `MUTATION_REJECTED`.

Resource resolution, reads, anchor and target validation, change application, and guards all finish before persistence. Failures in those steps write nothing. If a write fails after another Resource was written, core attempts to restore the failed Resource and every earlier write from their saved snapshots. `WRITE_FAILED` states whether rollback completed and lists any Resources that could not be restored. Failures after all writes and final rereads may instead report that the effect was already applied.

The bundled overwrite guard blocks a changed existing Resource when one applied change covers `[0, before.content.length)`. The check does not depend on the tool name. The first call asks the agent to repeat the same final mutation. A matching second call is allowed automatically and consumes the pending attempt.

## Ordering

Initial plugin setups are serialized in accepted registration order. Handler order follows committed registration order.

At invocation start, core snapshots handlers for the selected tool. Contributions added during an invocation are visible only to later invocations.

Handlers are awaited sequentially. Version 1 has no handler priority or graph edges.

## Handler failure

A thrown or rejected handler stops the pipeline and returns:

```ts
{
    kind: "failed",
    failure: {
        code: "PLUGIN_FAILED",
        pluginId,
        tool,
        stage,
        message,
        cause,
    },
}
```

## Non-goals

The pipeline does not provide:

- Pi tool registration or schemas;
- source-specific I/O;
- anchor parsing or stale-anchor policy;
- batching, undo, redo, or recovery;
- UI rendering;
- execution through `pi.events`.

Batch recovery reuses the registered mutation and the normal execution path, but it remains an integration concern outside the pipeline. See [Batch recovery](/src/extensions/pi-agent-text-editor/docs/batch-recovery.md).
