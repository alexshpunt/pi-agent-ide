# Readable IDE results and private records

IDE tools expose readable text in direct calls. In native Codemode, Search returns `{ result, hasMatches, complete }`. `result` is the unchanged readable Search string used for composition. The two nullable facts describe original matches and query coverage, independently of display truncation. Unknown facts are `null`; a failed call still rejects.

An image Read in Codemode returns the native image block `{ type: "image", data, mimeType, note }`, or `{ type: "images", note, images }` for several frames, so scripts can pass it to `image()`, `models.classify()` or Write `content` to save it as a file. Its `note` is the readable result string used for composition. Other text results remain strings. Private result records remain hidden.

## Composition

Each readable result string starts with a labelled system-result envelope containing a random UUID. It is not part of a file and must not be edited or inserted into file contents.

```js
const source = await tools.read({ path: "notes.txt", offset: 10, limit: 20 });
const matches = await tools.search({ path: source, query: "regex:old\\w*" });
text(await tools.replace({ path: matches.result, text: "new" }));
```

Pass the unchanged result string to a supported source parameter. Use Search's `result` field inside Codemode. Direct calls also accept the issued UUID. Store/load retains results across scripts in the same session. Displayed item and capture references allow narrower selections without inspecting private arrays.

A result identifies its backend-owned ranges, not the text in its preview. Shortened output does not clip a complete selection or make an incomplete selection complete. Read around a selection may show context without granting authority to edit it.

## Reference ownership

The session registry issues UUIDs and maps them to source handles. A guessed or computed hash has no authority unless the registry issued that reference. UUIDs are opaque references, not content hashes or signatures.

The registry validates session/worktree ownership, exact full-output identity, successful source status and live snapshots. Copying a valid ID within its session is intentional reuse, not forgery. Altering the body while keeping the envelope is rejected. An ID cannot grant wider ranges than its original selection.

Changed files permanently retire old source and derived references. Restoring the old bytes does not revive them. Actual edit completions and script boundaries observe filesystem generations; retained source bytes are verified before use. Reload and session changes clear the registry.

Pending edits reserve source handles without granting authority to unconfirmed writes. A dependent source operation commits the batch before using such a handle. Failed or cancelled edits cannot confirm it. Independent peer edits retain their original snapshots until the common commit.

Read-only views, raw bytes, images and directory listings do not acquire text-edit authority. Their IDs can identify the resource for another read. Live shell/debugger references can be used only with their owning resource operations. File deletion supplies no reusable text selection.

## Internal records

Each tool owns its validated record. Read, Search, Diff, terminals, Git and debugger operations keep their own domain adapters. File edit receipts contain only operation, observed effect, file states and an optional verified selection handle. Delete omits selection fields. The parent Codemode result retains committed operation effects and errors.

The text registry stores only ownership, a digest of the issued text, source references, resource identities and whether the result can be consumed. It does not copy line arrays, removed file contents, image bytes or debugger records into a second ledger. Source ranges and snapshots remain in the source-target store.

The unified registration adapter declares the small public Codemode schemas of Search and Read and hides their private domain records. Public tool_result hooks register the source metadata, preserve readable content for direct calls, and attach only the public script value as structuredContent. Other text tools keep their existing return behavior, including resource-provider values. This does not modify Pi, rewrite scripts, add VM methods, or recognize JSON in Codemode output.

Nested image blocks are delivered on the parent Codemode result once; an image the script already showed with `image()` is not attached again. Their bytes are not printed as text. Images remain ordinary native image content.
Read's private native record contains image type and MIME metadata, not another copy of the image bytes. Large images therefore do not overflow the JSON-record budget while their native content stays unchanged.

## Safe provider error metadata

A provider can attach public rate-limit data to `ResourceError` through its fourth constructor argument:

```ts
import { ResourceError } from "pi-agent-ide/api/resource";

throw new ResourceError("SERVICE_RATE_LIMITED", source, "not-applied", {
  metadata: { rateLimit: { retryAfterMs: 60_000, requestsRemaining: 0 } },
});
```

`metadata.rateLimit` accepts `retryAfterMs`, `resetAt`, `requestsLimit`, `requestsRemaining`, `complexityLimit`, `complexityRemaining`, `endpointLimit`, `endpointRemaining` and `endpoint`. Numeric values must be non-negative safe integers; `retryAfterMs` must not exceed 24 hours. `resetAt` is a Unix timestamp in milliseconds. `endpoint` is an identifier of at most 80 characters using letters, digits, underscores, colons or hyphens.

Construction keeps a fresh frozen snapshot of the allowed fields. Unknown keys and malformed values are dropped. Read preserves this metadata while rebuilding safe errors and includes it in `ResultError.metadata`. Arbitrary exception properties, private causes, response bodies and raw headers are excluded. Other tool adapters must opt into the same public metadata contract.

Metadata does not change an operation's effect or authorize a retry. A renderer or provider adapter may present the supplied timing without exposing its private transport diagnostics.

## Errors and writes

Failed tools reject in Codemode. Use try/catch or Promise.allSettled when independent calls may fail. Inspect the readable file/operation effects and final parent result before retrying. An error does not prove rollback.

Automatic batch boundaries save pending edits, not their final formatting. Write finishes its own post-edit processing before returning. Final post-edit processing can retire earlier snapshots. Ordinary script errors keep accepted edits; abort/deadline discards pending writes, not already committed batches.

After an exact-text selector fails, the tool returns current anchors and blocks further exact-text edits for that file. Use a current anchor for the next successful edit. Exact text is then available again.

See [editing](./agent-guides/editing.md), [Read](./agent-guides/read-resources.md) and [Search](./agent-guides/search-code.md) for their source and boundary contracts.
