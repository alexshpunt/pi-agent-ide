# Native IDE results

Read, Search, text mutations, Apply, diff, Git index tools, and debugger creation declare an `outputSchema` and return `structuredContent`. Native Codemode receives that object. Normal calls keep their readable content and existing renderers. Renderer `details` are not a script API.

The shared envelope is:

```ts
{ status: "success", data: /* tool data */, errors: [] }
{ status: "error" | "partial", data?: /* observed data */, errors: [{ code, message, source? }] }
```

`success` means the requested operation completed, including a search with no matches. `partial` means some work completed while other work failed. Output clipping is reported separately; it does not make a successful read an execution failure. `error` and `partial` set native `isError`.

Check `status` before using data. Domain errors with structured results resolve in native Codemode; they do not automatically throw. Invalid arguments, blocked calls, and cancellation can still reject. A mutation error does not imply rollback. Check its observed effects before retrying.

## Data by tool

- **Read:** `kind` is `text`, `bytes`, `native`, or `resources`. Text has original numbered `lines`, line endings, optional editable `anchors`, and source-level `references`. Bytes have exact `bytes: number[]`, byte offset, selected length, and total size. Native content has ordered text/image `blocks`; pass an image block to `image(...)`. Multi-source selections keep separate child resources.
- **Search:** `matches` have a source, exact line/column range, optional matched text, and optional `references.line` / `references.match` selectors. Columns are zero-based UTF-16 offsets. `complete` describes the backend search; `truncated` describes the public window. `all` selectors exist only for complete registered selections. File searches return paths. Other resolvers return their documented JSON domain data under `kind: "custom"`.
- **Mutations:** `operationId` identifies the call. `effect` and per-source `files` distinguish `pending`, `applied`, `not-applied`, and `unknown`. Recovery candidates, semantic action fields, and transaction receipts are included when available. Full before/after documents are not copied into receipts.
- **Flush:** `operations` link final effects and errors to accepted child call IDs. It also returns per-source effects. An empty flush succeeds with no operations. A failed flush retains writes that happened and never replays accepted edits.
- **Apply:** `operations` keep read and mutation outcomes in call order, including failed work. `files` and `transactions` retain committed checkpoints after a later failure. `values` contain only output explicitly requested by the script, not hidden snapshots.
- **Diff:** returns source identities, equality, added/removed counts, and bounded unified diff text. It does not repeat both source documents.
- **Git index tools:** return action, change selector, file, index state, observed effect, and whether it was already in the requested state.
- **Debugger:** creation returns session, source, and breakpoint resource references plus configuration and status. Debugger mutation actions return selected breakpoint or evaluation fields, not full session snapshots.

### Possible-name groups

After a complete zero result, eligible local and URL identifier searches can add `fuzzy: { status, message?, candidates }`. The original `matches` stays empty. Each candidate has `identifier`, a mechanical `kind` and `reason`, captured `matchCount` and `fileCount`, and a separate `selection` using the normal match/range/reference fields.

Candidate selections show at most three locations. Their `truncated` flag describes that display window; `complete` describes the exact alternative's capture. Limited capture has lower-bound counts and no complete `all` reference. URL candidates use URL ranges, never editable Search references. A `skipped` branch explains its budget or extra-branch failure without changing the completed ordinary zero into an error.

## Native editor commits

Sequential local edits share original snapshots. Child success with `effect: "pending"` means accepted, not written. Await an explicit flush when the script needs the final receipt:

```ts
const found = await tools.search({ query: "old", path: "note.txt" });
if (found.status !== "success") throw new Error(found.errors[0].message);
const changed = await tools.replace({ path: found.data.matches[0].references.match, text: "new" });
if (changed.status !== "success") throw new Error(changed.errors[0].message);
const saved = await tools.flush({});
text(saved);
```

Resource-owned selectors may commit immediately rather than joining the local batch. Another tool or parent completion also commits pending local edits. The parent Codemode result records automatic commits in `details.editorBatchResults`; those reports contain receipts, not source snapshots. Ordinary script errors keep accepted independent edits. Abort and deadline discard pending edits but do not undo earlier commits.

## Bounds and continuation

Public structured results must be finite plain JSON and fit within 1 MiB. Text windows keep at most 2,000 lines and 512 KiB of serialized line data. Raw byte windows keep at most 32,768 bytes, within the normal raw-read display budget. Registered search results keep the first 100 matches and at most 4 KiB of matched text per match.

Read `continuation` is a complete next request with a resolved source and absolute offset. Follow it rather than recomputing offsets from a rendered annotation. `fullResult` identifies retained complete output when available. A huge indivisible block or invalid adapter returns an explicit error rather than a clipped success. Temporary references belong to their runtime.

Native structured content is not copied into stored session messages. Existing compact renderer details stay separate. Scripts that explicitly print large data still store what they print.
Guides attached to native structured child calls stay on the readable parent result, even when the script prints only selected data. They do not become fields in the public data schema.

## Resolver adapters

Search resolvers must provide `toScriptData(payload, formattedDetails)`. Select documented JSON domain fields or use `selectionData` from `pi-agent-search/api/search`. Missing adapters fail with `STRUCTURED_ADAPTER_REQUIRED`; invalid schema or non-JSON values fail with `INVALID_STRUCTURED_RESULT`. Neither case falls back to display-text parsing or raw payload dumping.

Standard Read Resources use the core text/bytes/native projection. Read handlers that return their own result must supply `script: ReadScriptData`; custom content needs an explicit supported projection. Source-level references and line anchors come from presenters, not parsed annotations.

The shared validation helpers live in `pi-agent-resource`. Read and Search export their data/output schemas through their existing public tool APIs. Text mutation schemas and `structuredMutation` are exported through `pi-agent-text-editor/api/mutation-result`.

Shell command results keep their separate native process contract. This change does not add a shared result store, cross-session handles, binary editing, or a new Apply interpreter.
