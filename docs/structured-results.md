# Readable IDE results and private records

IDE tools expose readable text in direct calls. In native Codemode, Search returns `{ result, hasMatches, complete }`. `result` is the unchanged readable Search string used for composition. The two nullable facts describe original matches and query coverage, independently of display truncation. Unknown facts are `null`.

A text Read in Codemode returns `{ text, id }`. `text` is exactly the requested text without the envelope, notices or continuation hints: the whole source without `offset` and `limit`, the exact window with them, or the presentation of the requested views, such as anchors, jq output or an AST view. `JSON.parse(r.text)` works on a JSON file, and writing `r.text` back leaves the file unchanged. `id` is the `RESULT#<uuid>` of the result, and the value or its id selects the same text or window as the readable result. A `raw:` Read returns `{ bytes }`, the base64 of every requested byte; a directory returns `{ entries }`, whose directory names end with `/`. An image Read returns Pi's image block `{ type: "image", data, mimeType }`, or `{ type: "images", images }` for several frames, so scripts can pass it to `image()`, `models.classify()` or Write `image` to save it as a file. Read also takes an array `path`: it reads each source on its own and returns an array in the same order, with `null` for each source that failed; the Codemode result lists only the failed sources. These values come from Read's complete data for a call another tool issued: no line, byte or output limit applies, and a direct call keeps its bounded readable text. Diff returns the complete unified diff as a string, without the system-result envelope or the truncation of a direct call, and `""` when the sources are equal. Replace, insert, write, copy, move and undo return the `RESULT#<uuid>` id of the text they produced, or `null` when they select no text; delete returns `null` (see [Tools](./tools.md)). Other text tools return strings. Private result records remain hidden.

## Composition

Each readable result string starts with a labelled system-result envelope containing a random UUID. It is not part of a file and must not be edited or inserted into file contents.

```js
const source = await tools.read({ path: "notes.txt", offset: 10, limit: 20 });
if (source !== null) {
  const matches = await tools.search({ path: source, query: "regex:old\\w*" });
  if (matches !== null) text(await tools.replace({ path: matches.result, text: "new" }));
}
```

Pass a Read value, its `id`, an edit's id or an unchanged result string to a supported source parameter. Use Search's `result` field inside Codemode. Direct calls also accept the issued UUID. A source parameter accepts any object whose `id` holds a `RESULT#` reference, alone or in a list; the IDE resolves the id and ignores the object's other fields. An id the IDE did not issue fails like an unknown reference, even when it names a file. `file_search` and `semantic_search` take paths only, not results or values. Store/load retains results across scripts in the same session. Displayed item and capture references allow narrower selections without inspecting private arrays.

A result identifies its backend-owned ranges, not the text in its preview. Shortened output does not clip a complete selection or make an incomplete selection complete. Read around a selection may show context without granting authority to edit it.

## Reference ownership

The session registry issues UUIDs and maps them to source handles. A guessed or computed hash has no authority unless the registry issued that reference. UUIDs are opaque references, not content hashes or signatures.

The registry validates session/worktree ownership, exact full-output identity, successful source status and live snapshots. Copying a valid ID within its session is intentional reuse, not forgery. Altering the body while keeping the envelope is rejected. An ID cannot grant wider ranges than its original selection.

When a local file changes, its references follow the new text: a selection whose own text is unchanged moves to its new position, and one whose text changed is retired with a message that shows its current line. Every selection of a file is kept on the file's current text, also one registered from a text the tool read before another process wrote the file, so references from one or several searches combine in one edit. A check that finds a local file changed does not retire its other references; they follow the new text on their next use. Changes to other sources, such as URI resources, retire their references permanently; restoring the old bytes does not revive them. Actual edit completions and script boundaries observe filesystem generations; retained source bytes are verified before use. Reload and session changes clear the registry.

Pending edits reserve source handles without granting authority to unconfirmed writes. A dependent source operation commits the batch before using such a handle. Failed or cancelled edits cannot confirm it. Independent peer edits retain their original snapshots until the common commit.

Read-only views, raw bytes, images and directory listings do not acquire text-edit authority. Their IDs can identify the resource for another read. Live shell/debugger references can be used only with their owning resource operations. File deletion supplies no reusable text selection.

## Internal records

Each tool owns its validated record. Read, Search, Diff, terminals, Git and debugger operations keep their own domain adapters. File edit receipts contain only operation, observed effect, file states and an optional verified selection handle. Delete omits selection fields. The parent Codemode result retains committed operation effects and errors.

The text registry stores only ownership, a digest of the issued text, source references, resource identities and whether the result can be consumed. It does not copy line arrays, removed file contents, image bytes or debugger records into a second ledger. Source ranges and snapshots remain in the source-target store.

The unified registration adapter declares a Codemode output schema for every IDE tool, the tool's value or `null`, and hides private domain records. Each tool's value, its schema and its projection from a successful result, lives in that tool's own module in `src/composite/script-values/`, so a change to one tool's value touches one module. A tool without its own module resolves to its readable string. `match.ts` holds the one match type reserved for the values of Search, ast_search and lsp_search; today all three resolve to `{ result, hasMatches, complete }`. `file_search` resolves to its matching paths as a `string[]`, as a direct call lists them; a call from a script lists every match unless it sets `limit`. Structured results are limited to 1 MiB, but Search core lifts that limit for a script's call (the `script` audience), so such a list is never cut or refused for its size. `semantic_search` resolves to its files in rank order as a `string[]`; approximate ranges stay in the readable text because they are not selections. Public tool_result hooks register the source metadata, preserve readable content for direct calls, and attach only the public script value as structuredContent. Edit tools resolve to the reference of their published result when its record names a verified text target, and otherwise to `null`; a resource provider's value takes precedence. This does not modify Pi, rewrite scripts, add VM methods, or recognize JSON in Codemode output.

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

In Codemode, every IDE tool resolves to `null` when its call fails, and the script continues. Failures include refusals such as an expired or unknown result reference and system-result text passed as file content, an edit that changed only some files or whose effect is unknown, and a call after a failed editor batch. Each tool declares its value or `null` as its output schema. Calls that already succeeded stay applied. A resource provider's action that is refused or has an unknown effect keeps its object receipt instead of `null`, because the receipt says what happened.

The Codemode result ends with a block that lists every failed IDE call, both when the script completes and when it throws. It starts with a count such as `2 of 300 IDE calls failed:`. Each entry names the tool and the source it was given, followed by the readable error text a direct call shows, including its recovery steps and anchors. A failed edit that changed files, or whose effect is unknown, names those files and says not to repeat the edit blindly. Edits that a batch accepted and that failed when the batch was saved are listed as well; their value was already returned when they were accepted.

Error text carries no system-result envelope, so a failed result cannot be passed on as a selection. Direct calls keep readable failure text and the error flag.

Pi still rejects calls that never reach an IDE tool: arguments that do not match the tool's schema, unknown tools, and calls blocked by another extension's `tool_call` handler. Use try/catch or `Promise.allSettled` for those.

Pi 1.5.2 drops a `null` `structuredContent` that a `tool_result` handler returns. The IDE therefore sets the `null` value of a failed call, or of an edit that selects no text, on the nested result in `tool_execution_end`, which Pi emits before it hands that result to the script.

For a fragmented address, a declared `ResourceError` owns the failure of that complete resource. Read preserves its public code and source without retrying the bare address or interpreting the fragment as a text anchor. Ordinary unclaimed addresses can still use text-anchor fallback.

Check the readable operation effects and the failure block of the parent result before retrying. An error does not prove rollback.

Automatic batch boundaries save pending edits, not their final formatting. Write finishes its own post-edit processing before returning. Final post-edit processing can retire earlier snapshots. Ordinary script errors keep accepted edits; abort/deadline discards pending writes, not already committed batches.

After an exact-text selector fails, the tool returns current anchors and blocks further exact-text edits for that file. Use a current anchor for the next successful edit. Exact text is then available again.

Edit tools share one selection rule in the system prompt: anchor kinds, whole-line and exact-text boundaries, and line endings. Search explains Boolean parsing and broadened queries in the result where they apply.
