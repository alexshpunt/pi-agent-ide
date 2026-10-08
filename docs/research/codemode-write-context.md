# Codemode Write context verification

[LPT-666](https://linear.app/alexshpunt/issue/LPT-666/verify-codemode-write-results-do-not-duplicate-file-content-in-model)

## Finding

Silent nested Write did duplicate file text into the next provider request. The IDE's native editor-batch hook appended the final Write presentation to Codemode output, even when the script printed nothing. That extra presentation also bypassed Codemode's output limit.

The deterministic fixture writes 400 distinct marked lines (60,400 bytes). Its baseline includes the same content in script arguments but never calls Write.

| Following provider result              | Before the fix                                  | After the fix                                     |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Baseline                               | 47 text characters, no file-body markers        | Same                                              |
| Silent Write                           | 57,776 text characters, 337 file-body markers   | 47 script-output characters, no file-body markers |
| Explicit Write output, 1,000-token cap | An extra file fragment appeared outside the cap | Compact receipt only; no file text                |

These are character counts, not billed token measurements. The pre-fix result counts include the attached editing guide. After-fix output-size assertions exclude that separate guide; the saved request keeps it unchanged (6,345 characters in the captured run).

## Boundaries

- Script arguments legitimately contain the file content. The tests check them separately from subsequent tool-result content.
- `providerRequests` captures the exact input to the deterministic provider, not a paid HTTP request. It includes native SDK metadata as well as model-facing content.
- Native `details.calls` keeps a short argument preview. Native `nestedCalls` keeps call identity, status, timing, and bounded arguments or byte counts. These are not display-only IDE panels, and this change does not remove them.
- The inspected OpenAI Responses serializer converts tool results from `msg.content`; it does not send `details` or `nestedCalls` as tool output. Arbitrary custom providers can choose differently. We do not claim that the raw context object contains zero copied argument bytes.
- `ide-nested-results` is a saved custom entry for human-facing panels, not another model message. The fixture checks saved Write presentations and the rendered diff separately.

The fixtures use the pinned Pi 1.0.0 host. Live worktree verification uses installed Pi 1.1.0. Pi itself is unchanged.

Final live verification after reload covered direct Write, no-op Write, explicit nested output, silent 400-line Write, a directory-target failure, and Write-result reuse through Read. Direct and explicit Write output contained only status, one path, and the Read reminder; the failure added a short reason. Silent output stayed empty. Only the explicit Read exposed file content. `inspect_tui` captured Herdr `w3Q9:p1`, 105×108 cells, revision 344: the direct Write diff and the large nested diff's final rows/+400 count stayed visible. Existing argument-retention limits were labelled honestly.

Nineteen focused integration checks and ten capability-route unit checks passed. Final one-path and notice refinements were rechecked with three direct/error/Read cases and two notice/interruption cases. Typecheck, targeted lint, free capability coverage, and configured startup passed. No broad suites or paid inference ran.

## Compact Write contract

A later direct-call probe also returned a `Final text` file fragment. The user expanded the scope: Write must return only a write status, path, and a reminder to Read the file. Problems get a short reason, not file text or detailed diagnostics. Human-facing diffs stay visible.

Direct Write and explicit `text(result)` / `return result` now share that compact receipt. Small, large, and unchanged files do not produce content previews. Formatter availability, diff counts, source lines, and successful formatting details are not part of the agent receipt.

Keep full mutation data for the renderer and whole-file source targets. Read still consumes the unchanged Write result, including formatted and no-op snapshots. Explicit Read is the positive control for obtaining content; Codemode still owns that output's truncation and recovery file.

Silent native Write still does not append a second receipt or file body to the parent result. It keeps short problem notices when processing failed or was interrupted, native editor-batch metadata, and unrelated pending-edit receipts.

## Reproduce

```sh
pnpm exec pi-test run -- vitest run --config vitest.integration.config.mjs \
  tests/integration/native-codemode-write-context.integration.test.ts
pnpm exec vitest run scripts/tool-capability-matrix.test.ts -t 'capability route evidence'
pnpm check:capabilities
```

Each context case saves `following-provider-request.json` beside `run.jsonl` under `.tmp/test-runs/tests/integration/native-codemode-write-context.integration.test.ts/`. The test source regenerates these local captures; they are not committed.

Coverage includes direct small/large/no-op and failed Writes, silent and repeated Writes, explicit compact text/return, Read output truncation, short problem notices, native metadata, persisted panels, and the executable silent-Write capability case. Related Write target, formatting, batch-boundary, and after-save interruption checks protect result reuse and honest recovery.

The paid matrix declares `codemode.silent-write` and `edit.write-receipt`. It checks both the completed parent's output and the Write child's own content, not just tool names. No paid matrix routes were run; real-model execution remains unverified.
