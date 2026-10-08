# Codemode Write context verification

[LPT-666](https://linear.app/alexshpunt/issue/LPT-666/verify-codemode-write-results-do-not-duplicate-file-content-in-model)

## Finding

Silent nested Write did duplicate file text into the next provider request. The IDE's native editor-batch hook appended the final Write presentation to Codemode output, even when the script printed nothing. That extra presentation also bypassed Codemode's output limit.

The deterministic fixture writes 400 distinct marked lines (60,400 bytes). Its baseline includes the same content in script arguments but never calls Write.

| Following provider result        | Before the fix                                  | After the fix                                     |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Baseline                         | 47 text characters, no file-body markers        | Same                                              |
| Silent Write                     | 57,776 text characters, 337 file-body markers   | 47 script-output characters, no file-body markers |
| Explicit output, 1,000-token cap | An extra file fragment appeared outside the cap | Only capped script output carries file text       |

These are character counts, not billed token measurements. The pre-fix result counts include the attached editing guide. After-fix output-size assertions exclude that separate guide; the saved request keeps it unchanged (6,345 characters in the captured run).

## Boundaries

- Script arguments legitimately contain the file content. The tests check them separately from subsequent tool-result content.
- `providerRequests` captures the exact input to the deterministic provider, not a paid HTTP request. It includes native SDK metadata as well as model-facing content.
- Native `details.calls` keeps a short argument preview. Native `nestedCalls` keeps call identity, status, timing, and bounded arguments or byte counts. These are not display-only IDE panels, and this change does not remove them.
- The inspected OpenAI Responses serializer converts tool results from `msg.content`; it does not send `details` or `nestedCalls` as tool output. Arbitrary custom providers can choose differently. We do not claim that the raw context object contains zero copied argument bytes.
- `ide-nested-results` is a saved custom entry for human-facing panels, not another model message. The fixture checks saved Write presentations and the rendered diff separately.

The fixtures use the pinned Pi 1.0.0 host. Live worktree verification uses installed Pi 1.1.0. Pi itself is unchanged.

Live verification after reload used silent small and 400-line Writes, explicit output, and Write-result reuse through Read. Silent parent output contained no file text; explicit output appeared once. `inspect_tui` captured the real Herdr pane `w3Q9:p1` at 105×108 cells: the small Write diff and the large diff's final rows/count remained visible. The large panel honestly reported existing argument-retention limits.

## Fix

Keep immediate Write results available to the script, nested panels, and session history. Do not append their successful file fragments to the parent Codemode result. Preserve editor-batch metadata, ordinary batch receipts, failed results, syntax notices, formatting failures, and recovery statuses. Notices do not need another copy of the saved file.

Explicit `text(result)` and `return result` still deliver the Write result once. Codemode still owns output truncation and its full-output recovery file.

## Reproduce

```sh
pnpm exec pi-test run -- vitest run --config vitest.integration.config.mjs \
  tests/integration/native-codemode-write-context.integration.test.ts
pnpm exec vitest run scripts/tool-capability-matrix.test.ts -t 'capability route evidence'
pnpm check:capabilities
```

Each context case saves `following-provider-request.json` beside `run.jsonl` under `.tmp/test-runs/tests/integration/native-codemode-write-context.integration.test.ts/`. The test source regenerates these local captures; they are not committed.

Coverage includes silent and repeated writes, explicit text and return, truncation, error recovery, syntax/formatting notices, native metadata, persisted panels, and the executable silent-Write capability case. Related Write formatting, batch-boundary, and after-save interruption checks protect existing behavior.

The paid matrix now declares `codemode.silent-write` and checks completed parent output, not just child tool names. No paid matrix routes were run; real-model execution remains unverified.
