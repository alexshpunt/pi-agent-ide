# Context research: native Codemode edit batching

This records the investigation at revision ce8e0bc, before implementation. Keep its red-probe findings as historical evidence. The [solution decision](native-codemode-batch-decision.md) describes the agreed behavior; the linked suite now tests the implementation.

## Question

Can sequential calls to the existing editor tools share an original file snapshot and one combined write through native Pi Codemode, without replacing Codemode or bypassing Pi's tool pipeline?

## Findings

### Sequential calls currently write immediately

The real-Pi probe reads anchors, awaits an insertion, then awaits a replacement and a deletion using the original anchors. The insertion writes immediately. The replacement rejects its now-stale line anchor, so the deletion is never called. The real file contains only the insertion. The stale-anchor guard works; the requested sequential batch does not.

**Evidence:** [`native-codemode.integration.test.ts`](https://github.com/alexshpunt/pi-agent-ide/blob/de82738/tests/integration/native-codemode.integration.test.ts), revision `de82738`. `pnpm test:integration tests/integration/native-codemode.integration.test.ts` returned one failing test. Its stale-error and partial-file checks passed before the batch-success assertion failed.

### The current coordinator needs all calls before execution

`rewriteMessage()` discovers adjacent editor calls in an assistant message and builds a complete plan at `message_end`. `executeWithBatchCoordinator()` executes that plan once and splits its results between the original calls. A native Codemode message contains one script call, not the editor calls the script will later issue. Those child calls therefore have no precomputed plan.

`executeRegisteredTextBatch()` resolves each operation against the same text map, rejects overlapping edits and passes the combined changes to `core.editTexts()`.

**Evidence:** [`text-edit-batch-coordinator.ts`](../../src/extensions/pi-agent-text-editor/src/core/text-edit-batch-coordinator.ts), `rewriteMessage`, `ensureBatchExecution`, `executeWithBatchCoordinator`; [`text-edit-batch-registrar.ts`](../../src/extensions/pi-agent-text-editor/src/core/text-edit-batch-registrar.ts), `executeRegisteredTextBatch`.

### Waiting for future awaited calls would deadlock

Native Codemode awaits `ctx.executeTool()` and returns its outcome to the sandbox. In a sequential script, the next child call does not exist until the previous promise resolves. Holding the first promise open until the complete batch is known would stop the script from issuing the rest of the batch.

This means an accumulating batch must return a truthful acceptance result before the combined write. It cannot return the current final-file result from the first call.

**Evidence:** Pi `v0.99.1` [`execute.ts`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/extensions/codemode/execute.ts), `executeCodemode`; [`native Codemode contract`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/extensions/codemode/tool.ts).

### Public hooks expose the parent and child boundaries

Pi's `tool_call`, `tool_result` and `tool_execution_*` events carry `parentToolCallId` for nested calls. Child IDs belong to the calling tool, but the coordinator should use the parent field rather than parse the ID string. These hooks offer a place to associate editor invocations with a script and to finish pending work before another tool or the parent result is returned.

A `tool_result` handler can replace content, details and error status. Execution-end notifications alone are not a substitute for reporting a failed commit through the parent result. A hook that merely throws is also not sufficient: Pi reports handler failures and may continue.

The public events make this approach plausible. They do not prove a working deferred batch; no implementation or live commit-boundary probe has been added yet.

**Evidence:** Pi `v0.99.1` [`extension contracts`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md), Tools and Errors and cleanup; [`event types`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/core/extensions/types.ts); [`nested runner`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/core/nested-tool-calls.ts).

### The editor already separates planning data from writing

Mutation registrations return `TextChange` entries and optional `afterWrite` actions. The existing batch path gathers those changes before writing. `core.editTexts()` prepares resources, resolves anchors, applies combined changes, runs mutation guards and writes through the owning resource resolvers under its mutation queue.

A deferred batch can reuse these mechanisms, but the existing executor is not an appendable session. Planning must be separated from committing. Accepted operations should not be rerun to rebuild their plans at commit: that could repeat plugin work or change which selection was accepted. Resource content must be checked again at commit so external changes do not get overwritten.

Not every invocation of an editor-named tool is a text edit. Direct transactions, whole-file operations and semantic resource actions have separate execution paths. They cannot be silently treated as ordinary queued text changes.

**Evidence:** [`mutation-tool.ts`](../../src/extensions/pi-agent-text-editor/src/api/mutation-tool.ts), `TextMutation`, `TextMutationToolRegistration`; [`text-mutation.ts`](../../src/extensions/pi-agent-text-editor/src/core/text-mutation.ts), `createTextTool`; [`text-editor-core.ts`](../../src/extensions/pi-agent-text-editor/src/core/text-editor-core.ts), `editTexts`, `editTextResources`; [`batch registrar`](../../src/extensions/pi-agent-text-editor/src/core/text-edit-batch-registrar.ts), `expectedContent` checks and `textChangesConflict`.

### Final processing can reuse an existing scope, but it is not a pending-write batch

`createPostEditScope()` already collects final processing per resource. Its writes remain immediate, so using it alone would not fix the failing snapshot test. It is a possible reuse point for formatting and notifications after a combined write, not a replacement for the batch planner.

**Evidence:** [`post-edit-scope.ts`](../../src/extensions/pi-agent-text-editor/src/core/post-edit-scope.ts), `createPostEditScope`; [`Apply execution`](https://github.com/alexshpunt/pi-agent-ide/blob/c4ccbf9e8620976b5130e6f351f2678ce1d1a067/src/extensions/pi-agent-text-editor/src/core/apply/execution.ts), `finish`. This is an internal reuse observation, not a request to make Apply callable from Codemode.

### Some failure boundaries still need proof

Deferred work changes when disk failures can reach the script. A child promise can report acceptance, while a later commit may fail. The parent result must distinguish accepted, applied and rejected operations; child success alone cannot mean the file was written.

Native Codemode records successful script store writes before returning its own result. Finalizing edits in a later parent-result hook cannot assume those store writes are rolled back if the edit commit fails. Cancellation also differs from an ordinary JavaScript exception: queued work must not silently keep writing after an aborted parent. Concurrent scripts, interrupted child work and cleanup need dedicated runtime checks before this direction can be called safe.

**Evidence:** Pi `v0.99.1` [`execute.ts`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/extensions/codemode/execute.ts), sandbox result handling and `appendEntry`; [`nested runner`](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/src/core/nested-tool-calls.ts), nested call lifetime. These cases are not covered by the existing sequential probe.
