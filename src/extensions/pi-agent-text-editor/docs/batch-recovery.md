# Batch recovery

Text mutation recovery belongs to `pi-agent-text-editor` and has three internal parts.

- The batch coordinator owns the execution journal, one recovery attempt, and final results for the original tool call IDs.
- The tool-call interceptor reports that a streamed call was blocked. It does not decide which later calls are safe.
- The editor core owns text-specific dependency rules and executes safe calls through the normal mutation path.

## Native Codemode

Eligible local text edits in one native Codemode script accumulate against original file snapshots. Each batched child returns acceptance, not a written-file result. Write is immediate: it commits earlier pending edits, then saves its file and finishes its own post-edit processing before returning. Planning checks anchors and overlapping changes without writing. A boundary commits the accepted plan once through the normal editor queue, guards and Resource writes. For batched edits, registered resource post-edit handlers stay deferred until the end of that script, once per surviving resource.

Another tool, a whole-file operation, or a resource-owned selector ends the pending batch before its own execution. Later local edits start a new batch. Ordinary script exceptions still commit accepted independent edits. Agent aborts and script deadlines discard pending writes; already committed batches remain committed.

Commit checks both original content and file existence. A changed source fails instead of replaying mutations. The parent result preserves native child receipts and adds final file effects and `editorBatches` states keyed by child call ID. A failed commit makes the parent a tool error. Accepted child calls alone are not proof of persistence.

Successful acceptance returns `pending`. Automatic commits record observed file and operation effects with accepted child call IDs. A failed commit preserves applied effects and does not replay edits. The parent keeps these receipts under `editorBatchResults`.

Local replace/insert acceptances carry reserved RESULT# handles. A successful commit maps each call's actual inserted ranges through all batch peers, checks the written snapshot and confirms its handle. Search or a dependent replace can consume the result directly; the dependency boundary commits first. Original child receipts remain pending. Failed, cancelled, unsupported or uncertain writes do not grant targets. Immediate resource-owned mutations share the same post-edit scope and final parent presentation. Final formatting that changes source bytes makes earlier targets stale; targets are never rebound to formatted text.

This is not a transaction over arbitrary JavaScript. Native Codemode stores and other completed tool effects are not rolled back. Standalone editor batching keeps its existing execution path.

## Execution states

Every call starts as `pending`. The aggregate executor changes it to `running`, then to `completed` or a failure state. Failures record whether an effect was `not-applied`, `applied`, or `unknown`. Guard blocks are recorded separately as `blocked` and are always treated as not applied.

A running call becomes `failed-unknown` when an exception crosses the executor without a more precise effect report. Applied and unknown calls are never executed again.

## Recovery rules

Recovery considers only complete calls that are still pending. It does not retry the call that stopped normal execution. This avoids repeating a deterministic failure and lets independent trailing work continue.

The editor derives affected resources from each mutation registration. The primary source and every target source participate. This covers cross-file copy and move without special tool-name checks. A pending call can run after an uncertain failure only when all of its resources are known and disjoint. If a resource cannot be resolved, recovery stops conservatively.

Plugin mutation tools participate automatically because batching and recovery use the same registration metadata and execution function.

Recovered mutations use the normal editor path, including anchor resolution, normalized mutation planning, and mutation guards.

## Results

The coordinator keeps one result for each original call ID. Completed calls keep their normal result. Recovered calls keep a recovered result. Blocked and failed calls keep their original structured failure when one exists. Calls that cannot run receive an explicit failure with the batch ID, final state, and reason.

Every final state other than `completed` is emitted as a Pi tool error while preserving its structured result.
