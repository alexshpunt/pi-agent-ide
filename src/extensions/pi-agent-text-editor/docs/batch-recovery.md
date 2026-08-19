# Batch recovery

Text mutation recovery belongs to `pi-agent-text-editor` and has three internal parts.

- The batch coordinator owns the execution journal, one recovery attempt, and final results for the original tool call IDs.
- The tool-call interceptor reports that a streamed call was blocked. It does not decide which later calls are safe.
- The editor core owns text-specific dependency rules and executes safe calls through the normal mutation path.

## Execution states

Every call starts as `pending`. The aggregate executor changes it to `running`, then to `completed` or a failure state. Failures record whether an effect was `not-applied`, `applied`, or `unknown`. Guard blocks are recorded separately as `blocked` and are always treated as not applied.

A running call becomes `failed-unknown` when an exception crosses the executor without a more precise effect report. Applied and unknown calls are never executed again.

## Recovery rules

Recovery considers only complete calls that are still pending. It does not retry the call that stopped normal execution. This avoids repeating a deterministic failure and lets independent trailing work continue.

The editor derives affected resources from each mutation registration. The primary source and every target source participate. This covers cross-file copy and move without special tool-name checks. A pending call can run after an uncertain failure only when all of its resources are known and disjoint. If a resource cannot be resolved, recovery stops conservatively.

Plugin mutation tools participate automatically because batching and recovery use the same registration metadata and execution function.

Recovered mutations use the normal editor path, including anchor resolution, normalized mutation planning, and mutation guards. An overwrite rejection is not applied, is never uncertain, and cannot be bypassed by recovery.

## Results

The coordinator keeps one result for each original call ID. Completed calls keep their normal result. Recovered calls keep a recovered result. Blocked and failed calls keep their original structured failure when one exists. Calls that cannot run receive an explicit failure with the batch ID, final state, and reason.

Every final state other than `completed` is emitted as a Pi tool error while preserving its structured result.
