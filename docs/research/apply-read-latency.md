# Apply and Read latency research

This report records the LPT-238 investigation. It describes the current code on `develop` at `bf7f36db` and the retained benchmark evidence available on 17 September 2026. No product behavior was changed.

## Summary

Apply has a confirmed transaction scaling problem. A flush with many same-file selections does not write the final file once. It validates, snapshots, rebuilds, reads, and writes the whole file once per selection. It also retains one full before/after receipt per selection. On an 11,000-line, 407 KB fixture, 300 replacements took 50.7 seconds. A 1,000-replacement run did not finish within 249 seconds after the 300-replacement sample. This is enough to explain Apply calls that cross a 120-second benchmark timeout.

Apply also does avoidable work after the bytes are correct. Final post-processing is serial by file. Final diffs are built twice, once for model output and once for the TUI. Output limits are applied only after full diffs and full text have been built. These costs explain why a workspace can become exact before the tool call returns.

The basic Read text pipeline is not responsible for a 26–33 second delay by itself. Parsing, projecting, and bounding an 11,000-line, 407 KB text fixture averaged about 14 ms in a controlled run. The expensive Read candidates are optional views, post-read handlers, and TUI rendering, because they process the full document before compacting it. Retained benchmark trajectories do not contain phase timestamps, so they cannot assign a reported 26–33 second model cycle to the Read tool alone.

## Evidence from retained runs

The benchmark repository was used read-only.

The reported timeout group contains two different failure modes:

- Exact before process timeout: `delete-subset-1000-plain`, `insert-subset-1000-plain`, `multi-file-100-unicode`, and `delete-subset-1000-unicode`.
- Partial workspace at timeout: `multi-file-1-plain`, `multi-file-10-plain`, `multi-file-10-unicode`, `replace-all-1000-unicode`, and `insert-subset-1000-unicode`.

The exact cases prove that correctness and lifecycle completion are separate. The partial cases do not all prove one Apply call was slow. Some trajectories use many calls or touch only part of the requested file set. They must be classified from the trajectory before attributing the timeout to Apply internals.

A current retained trajectory is useful as a control:

- `results/local-pi-agent-ide-hard-oracle5-20260917/trials/delete-subset-1000-unicode__r01__pi-agent-ide/rounds/0/`
- It completed in 65.86 seconds with 18 tool calls and 11 model rounds.
- Its first line-range Apply was followed by a corrective Apply, then verification reads.
- The final mismatch was a selection/correctness issue, not proof of one 65-second Apply call.

The retained `stdout.jsonl` and `tool-calls.json` record order but not tool start/end wall-clock timestamps. They are insufficient for phase-level latency attribution. Future benchmark capture should preserve tool-call duration or tool lifecycle timestamps without changing pass/fail semantics.

## Apply lifecycle and costs

### 1. Guest execution

`src/extensions/pi-agent-text-editor/src/core/apply/runtime.ts`

`executeApplySource()` creates a sandbox and sends every host operation through `ApplyQueue`. The queue is deliberately serial. A flush sends all open snapshot content and every staged selection across the sandbox bridge.

This serialization is useful for deterministic snapshot semantics. It is not the main same-file 1,000-edit bottleneck, but the growing request and response payloads add cost.

### 2. Transaction execution is the primary bottleneck

`src/extensions/pi-agent-text-editor/src/core/apply/transaction.ts`

For every replacement, `executeEditorTransaction()` currently does all of the following:

1. Scans prior accepted changes for overlap.
2. Rebuilds expected content from the original snapshot and all prior changes.
3. Reads the whole current file for stale validation.
4. Reads and retains the whole current file again for rollback.
5. Rebuilds the before state.
6. Rebuilds the after state.
7. Calls `editor.editTexts()` with a full-file replacement.
8. Stores a receipt containing full before/after strings and detailed changes.

The accepted-change list grows after every selection. The overlap scan is quadratic. Repeated sorting and application of the growing list adds at least quadratic-logarithmic CPU work. Whole-file read/write/snapshot work is repeated `E` times for `E` selections. Receipts retain progressively changed full-file strings.

### Controlled transaction timing

Fixture:

- 11,000 lines
- 407,000 bytes
- non-overlapping replacements of `legacyCheckout` with `stableCheckout`
- real temporary file reads and writes
- the production `executeEditorTransaction()` function
- a minimal editor adapter with no formatter, diagnostics, presenters, or model

Results:

| Replacements |                             Transaction time |                  Full writes |           Full file receipts |
| -----------: | -------------------------------------------: | ---------------------------: | ---------------------------: |
|           10 |                                       125 ms |                           10 |                           10 |
|          100 |                                     5,647 ms |                          100 |                          100 |
|          300 |                                    50,726 ms |                          300 |                          300 |
|        1,000 | did not finish before the 300 s test timeout | more than 300 before timeout | more than 300 before timeout |

The 1,000 sample started after the first three samples, so it had less than 249 seconds available. It still establishes that the isolated transaction alone can exceed the benchmark's 120-second limit.

To reproduce, create a focused Vitest next to `apply-transaction.test.ts` that calls `executeEditorTransaction()` with the fixture above and logs elapsed time, write count, and `outcome.files.length`. Run:

```bash
pnpm vitest run src/extensions/pi-agent-text-editor/tests/core/<profile-test>.test.ts --reporter=verbose
```

Keep this as an explicit local profile, not a timing assertion in the test suite.

### 3. Snapshot refresh

`src/extensions/pi-agent-text-editor/src/core/apply/execution.ts`

After every `editorApply`, Apply refreshes every requested open snapshot with a full script-mode Read. It does this even for snapshots not changed by that flush. Script-mode Read also enables all registered views. This can add repeated full-document work between flushes.

### 4. Post-processing after bytes are correct

`src/extensions/pi-agent-text-editor/src/core/post-edit-scope.ts`

Intermediate post-processing is correctly deferred, but `finish()` runs one finalizer at a time. For many files, formatting, diagnostics, listeners, and presenters form a serial tail after the workspace has reached its final bytes. Apply also waits behind the editor's global mutation queue.

This is the clearest lifecycle explanation for `multi-file-100-unicode`: the files can become exact while finalizers continue serially.

### 5. Result and preview construction

`src/extensions/pi-agent-text-editor/src/core/apply/final-mutations.ts`

`finalApplyMutations()` scans mutation receipts for every final file and creates a unified diff. It is called independently by:

- `renderApplyOutput()` for model-facing output;
- `createApplyDisplay()` for TUI details.

`createUnifiedDiff()` itself runs two line-diff passes: one for the patch and one for statistics.

`src/extensions/pi-agent-text-editor/src/core/apply/output.ts`

The 2,000-line/50 KB limit bounds the returned result, not the work. Apply first builds complete sections and final diffs, joins the full text, and only then checks truncation. Oversized output is saved, then reducible sections are reduced serially. A summary is built only after this work.

The TUI renderer also receives full mutation data and can highlight, wrap, and render more rows than compact mode ultimately shows.

## Read lifecycle and costs

`src/extensions/pi-agent-read/src/core/tools/tool-read.ts`

Read currently performs these full-source stages before output truncation:

1. Read the complete resource.
2. Build a line document for the complete text.
3. Run matching read handlers.
4. Run requested presenters.
5. Validate and merge every presenter's contribution across every line.
6. Project and render the requested range.
7. Run post-read handlers.
8. Apply the model-facing output limit.

For script reads, all registered views are requested and model-facing output truncation is bypassed. Apply open and refresh operations use this mode.

`src/extensions/pi-agent-read/src/core/tools/read/read-renderer.ts`

Compact TUI mode compacts after content rendering. Syntax highlighting, Markdown rendering, normalization, and ANSI wrapping may therefore process the full result even when only 12 rows remain visible.

### Controlled core Read timing

Fixture:

- the same 11,000-line, 407 KB text;
- 20 iterations;
- production `createReadState()`, `projectReadState()`, and `limitReadOutput()`;
- no optional view, post-read handler, filesystem wait, or TUI.

Average:

| Phase                        |     Time |
| ---------------------------- | -------: |
| Build text document          |  3.45 ms |
| Project and render all lines |  9.55 ms |
| Apply 2,000-line/50 KB bound |  1.01 ms |
| Total measured core          | 14.01 ms |

To reproduce, create a focused Vitest beside `read-tool.test.ts`, construct the fixture in memory, time the three functions with `performance.now()`, and run:

```bash
pnpm vitest run src/extensions/pi-agent-read/tests/core/<profile-test>.test.ts --reporter=verbose
```

This result rules out the basic text projection as the source of a 26–33 second delay on this machine. It does not rule out resolver I/O, views, hooks, syntax highlighting, terminal rendering, or the next model response. Those phases need explicit live tracing.

## Recommended optimization order

| Priority | Change                                                                                                                                                    | Expected effect                                                                                        | Capability and risk                                                                                                                             |
| -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|        1 | Validate all same-file selections against one snapshot, apply the non-overlapping change set once, snapshot rollback state once, and write once per file. | Removes the confirmed 1,000-edit timeout mechanism and most receipt growth.                            | Keep per-operation outcomes and atomic rollback semantics. The main risk is preserving partial-failure reporting when one selection is invalid. |
|        2 | Store one net file result plus compact per-operation metadata instead of full before/after content for every selection.                                   | Reduces bridge payload and retained heap from roughly edit-count × file-size.                          | Preserve operation status, affected resources, undo, and final diff. Do not discard failure attribution.                                        |
|        3 | Reuse one computed final mutation/diff model for model output and TUI output. Compute statistics in the same diff pass.                                   | Removes duplicate final line diffs after bytes are correct.                                            | No capability loss. Ensure model redaction and TUI presentation remain separate projections of the shared data.                                 |
|        4 | Refresh only snapshots changed by a flush, and allow Apply's editable-text refresh to skip presentation views.                                            | Removes repeated full Read/view work between flushes.                                                  | Keep canonical text, line metadata needed by selections, and stale-snapshot checks.                                                             |
|        5 | Make independent final file post-processing concurrent with an explicit concurrency limit, while preserving notification order where required.            | Shortens the exact-workspace lifecycle tail for multi-file edits.                                      | Formatting or tooling that mutates shared project state may require serialization. Classify handlers before parallelizing.                      |
|        6 | Build bounded model output directly from final mutation metadata; create a full temporary preview lazily only when requested.                             | Avoids building huge previews merely to summarize them.                                                | Preserve access to full output through a temporary resource. Be careful that lazy generation sees the committed snapshot.                       |
|        7 | Make compact Read/Apply renderers clip before syntax highlighting and ANSI wrapping.                                                                      | Reduces synchronous TUI work and event-loop stalls on large results.                                   | Expanded mode must still show the full presentation. Compact output must keep the useful head/tail contract.                                    |
|        8 | Add phase timings to tool lifecycle records.                                                                                                              | Separates model, resolver, mutation, post-processing, output, and TUI delays in future benchmark runs. | Metrics must not alter timeout or correctness behavior and should be off or low-cost by default.                                                |

## Suggested next measurement

Before implementing, add temporary spans around these boundaries in a dedicated development branch:

- Apply sandbox run;
- transaction parse, validation, rollback snapshot, edit/write, and receipt assembly;
- snapshot refresh;
- deferred post-processing per file;
- final mutation/diff creation;
- model output reduction;
- TUI display creation and first render;
- Read resolver, document creation, each handler/view, projection, truncation, and TUI render.

Run one exact-before-timeout case and one partial case with tool start/end timestamps. This will show which partial cases are Apply latency and which are model/tool-selection trajectories.

## Implemented Apply changes

The implementation following this research now:

- batches consecutive non-overlapping replacements from one document into one guarded file write;
- keeps one outcome per requested operation and still rejects invalid or overlapping selections independently;
- captures rollback state once for the batch and records one undo transaction;
- retains one net file receipt instead of one progressive full-file receipt per selection;
- refreshes only snapshots whose resources were changed by a flush;
- computes final mutation diffs once and shares them between model-facing output and TUI display.

The reusable performance check is:

```bash
pnpm profile:apply
```

It runs the 11,000-line, 1,000-replacement transaction three times, checks byte-level effects and one write, and enforces the accepted five-second ceiling. The first completed implementation run measured 367.4 ms, 348.9 ms, and 342.3 ms. The pre-change transaction did not finish 1,000 replacements in the available 249 seconds.

## Conclusion

The largest confirmed problem was not preview construction. It was per-selection transaction execution: one logical 1,000-selection file edit became 1,000 whole-file validation, snapshot, rebuild, write, and receipt cycles. The implemented batching removes that primary cost. Snapshot refresh and duplicated diff work were also reduced without removing transaction, undo, output, or post-processing behavior.

Read needs tracing around views and TUI work, but the basic 11,000-line text pipeline is fast in isolation. The benchmark's reported 26–33 second cycles should not be labeled Read latency until tool lifecycle timestamps separate the Read call from model response time.
