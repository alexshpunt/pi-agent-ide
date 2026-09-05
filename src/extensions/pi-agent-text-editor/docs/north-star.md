# North Star: `pi-agent-text-editor`

## Thesis

`pi-agent-text-editor` gives an agent direct text mutation primitives.

It resolves one or more editable Resources, reads their current text, resolves opaque line anchors and typed text targets, applies one explicit operation, and writes through the same Resources.

## Ownership

The editor core owns:

- an independent Resource resolver registry;
- an independent text anchor resolver registry;
- a typed text target resolver view built from anchor registrations;
- resolver priority and stable registration order;
- plugin lifecycle and setup transactions;
- validation of Resource, anchor, and typed target resolver results;
- text mutation tools and edit pipeline stages;
- the local ChangeSet engine, applied text changes, and mutation guards before persistence;
- post-edit finalization, final rereads, and source-neutral completion notifications;
- prompt aggregation for writable sources, tool plugins, and active anchor resolvers.

The editor core does not own:

- source-specific I/O;
- anchor syntax, hashing, parsing, or presentation;
- the read pipeline;
- AST or language analysis;
- mutation history, undo policy, or persisted edit state.

Shared Resource contracts come from [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md). Shared anchor contracts come from [`pi-agent-text`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-text/north-star.md).

## Anchor invariant

An anchor value is opaque until a registered resolver handles it. A successful base anchor resolution returns one 1-based line number that exists in the current non-empty text snapshot.

The editor also accepts selection anchors with ordered, non-overlapping, half-open line and column ranges for one Resource. Core checks every range against the current Resource snapshot. The mutation operation decides whether it supports one range, every range in one Resource, or a set that spans several Resources.

A registered `TextTargetResolver` can resolve an opaque value before files are read. Its typed result contains ordered Resource sources and optional selection ranges. This lets one value act as a mutation path as well as an anchor. The resolver owns the syntax; editor consumers validate the typed targets and never parse strings such as `SEARCH#...`.

Base anchors have no range, boundary, insertion, before, after, or file-edge semantics. A mutation converts a position anchor to its natural whole-line range when the operation needs a selection. Empty files have no anchors and are created or replaced with `write`.

Mutation tools describe each change as inserted text over a half-open range in the original document. They do not construct final file content. The core applies all changes for a Resource once through its local ChangeSet engine, builds the Resource plan from the applied result, runs mutation guards, and only then starts writing. A full overwrite is therefore the same change whether it came from `write`, `replace`, `copy`, `move`, or another mutation tool.

For one edit, the editor snapshots the ordered anchor and target registries once. It expands typed targets before reading any Resource, then resolves explicit anchors independently against each selected current snapshot with the same cwd, signal, and registry snapshot. Compatible path ranges and explicit anchor ranges are unioned. Different Resource sets, incompatible selection shapes, ambiguous or overlapping ranges, and invalid spans are rejected before persistence.

A resolver may recover its own rejected value. Recovery is non-mutating: core validates candidate line/column spans, renders current context through the primary presenter, and keeps the original mutation blocked. Batch recovery recomputes candidates after successful writes and post-edit work.

## Resource mutation

`TextEditorCore.editTexts()`:

1. snapshots the Resource, target, and anchor resolver registries;
2. resolves typed source and anchor values to ordered Resource targets and ranges;
3. resolves and reads every declared or expanded Resource before mutation;
4. creates one anchor resolver context for each Resource;
5. resolves explicit anchors only through the registered resolver for each Resource and allowed kind;
6. unions compatible implicit target ranges and explicit anchor ranges;
7. lets the operation return generic text changes for one or more Resources;
8. applies each Resource's changes once through the local ChangeSet engine;
9. builds the complete mutation plan from the engine results and runs committed guards;
10. writes accepted changed Resources in stable order through the same Resource objects;
11. runs post-edit handlers and rereads each written Resource;
12. notifies completion listeners with the raw before and final after documents;
13. applies presenters to the final document used by tool results.

Resolution, snapshot validation, change application, overlap checks, and guards all finish before the first write. These failures leave every Resource unchanged. If a later Resource write fails, core attempts to restore that Resource and every Resource written earlier, then reports any rollback failures. Failures after all writes, such as post-write finalization failures, can report an applied effect instead of pretending the mutation was not persisted. `editText()` remains the one-Resource form of the same contract.

A claimed Resource or anchor failure is terminal. Only `not-handled` continues to the next resolver.

## Built-in search

The built-in `search` tool registers four typed search values. `SEARCH#HASH:N:line` selects one result's complete containing line and `SEARCH#HASH:N:match` selects its exact characters. Complete searches also register `SEARCH#HASH:all:line` for every unique containing line and `SEARCH#HASH:all:match` for every exact match across all matched Resources.

A line selection includes its LF or CRLF ending. Replacement preserves that ending when new text does not provide one. Insertion happens after the line by default and before it when `before: true`. A final line without an ending selects through EOF and remains without a trailing ending when replaced, unless the replacement text provides a line ending. Whole-line deletion removes the preceding separator when needed so the final line is removed cleanly, and adjacent whole-line deletions are coalesced. Match selections never include line endings.

Per-result values remain tied to the search-time snapshots and reject changed files as stale. Complete `:all` values rerun the stored search recipe when a selected file changes. Limited or incomplete searches omit the `:all` values and reject forged ones. Bare `SEARCH#HASH:N` and `SEARCH#HASH:all` forms are invalid and are not displayed.

## Extensions

Standard anchor formats are optional extensions:

- `pi-agent-text-anchor-line-hash` registers the major `LINE#HASH` resolver and matching read prefix;
- `pi-agent-text-anchor-constant` registers `begin` and `end` as constant line selectors;
- `pi-agent-text-anchor-exact` is the final fallback and selects any unique non-empty exact text span;
- `pi-agent-ide-ast` registers auxiliary scope anchors and matching sparse read markers.

Read presentation and edit resolution are separate registrations. A domain extension may register both and share local functions or state.

## Invariants

1. Read and editor Resource registries are independent.
2. Anchor and target contracts contain no tool or mutation semantics.
3. Every resolved anchor keeps one existing base line; target ranges also stay inside their Resource.
4. Typed targets expand all selected Resources before any mutation starts.
5. Every edit uses one resolver snapshot and one current text snapshot per declared Resource.
6. Resolver failure, malformed output, out-of-range positions, incompatible sources, and overlapping changes are terminal before writes.
7. A multi-Resource write failure triggers best-effort rollback and reports rollback failures.
8. Anchor descriptions come from active resolvers and are rendered only for active editor tools.
9. Source-specific persistence remains inside the Resource.
10. The editor reads and writes through the same Resource object.
11. Completion notifications describe committed text but are never retained as editor history.

## Batch recovery

Batch execution and recovery stay outside `TextEditorCore.executeEdit()`. The batch package owns execution progress and exactly-once coordination, while the editor integration owns resource dependency policy. See [Batch recovery](./batch-recovery.md) for the state model and retry rules.
