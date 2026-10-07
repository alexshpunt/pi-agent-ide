# Readable IDE results and private records

IDE tools expose readable text in direct calls and native Codemode. The existing Read views, Search anchors, edit effects and diffs remain the agent-facing output. Select shows its selected text and item references. Agents do not receive the private result records or need to inspect their fields.

## Composition

Each result starts with a labelled system-result envelope containing a random UUID. It is not part of a file and must not be edited or inserted into file contents.

```js
const source = await tools.read({ path: "notes.txt" });
const matches = await tools.search({ path: source, query: "old" });
const selected = await tools.select({ path: matches, operation: { kind: "trim", side: "both" } });
text(await tools.replace({ path: selected, text: "new" }));
```

Pass the unchanged result to a supported source parameter. Direct calls also accept its UUID. Store/load retains the result string across scripts in the same session. Displayed item and capture references allow narrower selections without inspecting private arrays.

A result identifies its backend-owned ranges, not the text in its preview. Shortened output does not clip a complete selection or make an incomplete selection complete. Read around a selection may show context without granting authority to edit it.

## Reference ownership

The session registry issues UUIDs and maps them to source handles. A guessed or computed hash has no authority unless the registry issued that reference. UUIDs are opaque references, not content hashes or signatures.

The registry validates session/worktree ownership, exact full-output identity, successful source status and live snapshots. Copying a valid ID within its session is intentional reuse, not forgery. Altering the body while keeping the envelope is rejected. An ID cannot grant wider ranges than its original selection.

Changed files permanently retire old source and derived references. Restoring the old bytes does not revive them. Actual edit completions and script boundaries observe filesystem generations; retained source bytes are verified before use. Reload and session changes clear the registry.

Pending edits reserve source handles without granting authority to unconfirmed writes. A dependent source operation commits the batch before using such a handle. Failed or cancelled edits cannot confirm it. Independent peer edits retain their original snapshots until the common commit.

Read-only views, raw bytes, images and directory listings do not acquire text-edit authority. Their IDs can identify the resource for another read. Live shell/debugger references can be used only with their owning resource operations. File deletion supplies no reusable text selection.

## Internal records

Each tool owns its validated record. Read, Search, Select, Diff, terminals, Git and debugger operations keep their own domain adapters. File edit receipts contain only operation, observed effect, file states and an optional verified selection handle. Delete omits selection fields. The parent Codemode result retains committed operation effects and errors.

The text registry stores only ownership, a digest of the issued text, source references, resource identities and whether the result can be consumed. It does not copy line arrays, removed file contents, image bytes or debugger records into a second ledger. Source ranges and snapshots remain in the source-target store.

The unified registration adapter omits public outputSchema. Pi's supported Codemode execution path therefore returns each tool's existing text instead of structuredContent. Public tool_result hooks register the private source metadata and return the readable text with its envelope. This does not modify Pi, rewrite scripts, add VM methods, or recognize JSON in Codemode output.

Nested image blocks are delivered on the parent Codemode result; their bytes are not printed as text. Images remain ordinary native image content.
Read's private native record contains image type and MIME metadata, not another copy of the image bytes. Large images therefore do not overflow the JSON-record budget while their native content stays unchanged.

## Errors and writes

Failed tools reject in Codemode. Use try/catch or Promise.allSettled when independent calls may fail. Inspect the readable file/operation effects and final parent result before retrying. An error does not prove rollback.

Automatic batch boundaries save pending edits, not their final formatting. Write finishes its own post-edit processing before returning. Final post-edit processing can retire earlier snapshots. Ordinary script errors keep accepted edits; abort/deadline discards pending writes, not already committed batches.

After an exact-text selector fails, the tool returns current anchors and blocks further exact-text edits for that file. Use a current anchor for the next successful edit. Exact text is then available again.

See [editing](./agent-guides/editing.md), [Read](./agent-guides/read-resources.md) and [Select](./agent-guides/select-code.md) for their source and boundary contracts.
