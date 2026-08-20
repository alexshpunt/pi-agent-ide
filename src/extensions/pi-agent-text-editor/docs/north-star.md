# North Star: `pi-agent-text-editor`

## Thesis

`pi-agent-text-editor` gives an agent direct text mutation primitives.

It resolves one or more editable Resources, reads their current text, resolves opaque anchor strings against those exact snapshots, applies one explicit operation, and writes through the same Resources.

## Ownership

The editor core owns:

- an independent Resource resolver registry;
- an independent text anchor resolver registry;
- resolver priority and stable registration order;
- plugin lifecycle and setup transactions;
- validation of Resource and anchor resolver results;
- text mutation tools and edit pipeline stages;
- the local ChangeSet engine, applied text changes, and mutation guards before persistence;
- post-edit finalization, final rereads, and source-neutral completion notifications;
- prompt aggregation for writable sources, tool plugins, and active anchor resolvers.

The editor core does not own:

- source-specific I/O;
- anchor syntax, hashing, parsing, or presentation;
- the read pipeline;
- AST or language analysis.
- mutation history, undo policy, or persisted edit state.

Shared Resource contracts come from [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md). Shared anchor contracts come from [`pi-agent-text`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-text/north-star.md).

## Anchor invariant

An anchor is an opaque string until a registered resolver handles it. A successful base anchor resolution returns one 1-based line number that exists in the current non-empty text snapshot.

The editor also accepts `TextSelectionAnchor`, which keeps the base line and adds ordered, non-overlapping, half-open line and column ranges for one Resource. Core checks every range against the current Resource snapshot. The mutation operation decides whether it supports one range, every range in one Resource, or a set that spans several Resources.

Base anchors have no range, boundary, insertion, before, after, or file-edge semantics. Empty files have no anchors and are created or replaced with `write`.

Mutation tools describe each change as inserted text over a half-open range in the original document. They do not construct final file content. The core applies all changes for a Resource once through its local ChangeSet engine, builds the Resource plan from the applied result, runs mutation guards, and only then starts writing. A full overwrite is therefore the same change whether it came from `write`, `replace`, `copy`, `move`, or another mutation tool.

For one edit, the editor snapshots the ordered anchor registry once. Every anchor argument resolves against the current text of its declared Resource, with the same cwd, signal, and registry snapshot.

An anchor registration may also expose the Resources selected by a global anchor. The editor expands those Resources before it reads any file, then resolves the same anchor independently against each current snapshot.

## Resource mutation

`TextEditorCore.editTexts()`:

1. snapshots the Resource and anchor resolver registries;
2. expands Resources from any anchor that provides a Resource resolver;
3. resolves and reads every declared or expanded Resource before mutation;
4. creates one anchor resolver context for each Resource;
5. resolves every anchor only through the registered resolver for its Resource and kinds;
6. lets the operation return generic text changes for one or more Resources;
7. applies each Resource's changes once through the local ChangeSet engine;
8. builds the complete mutation plan from the engine results and runs committed guards;
9. writes accepted changed Resources in stable order through the same Resource objects;
10. runs post-edit handlers and rereads each written Resource;
11. notifies completion listeners with the raw before and final after documents;
12. applies presenters to the final document used by tool results.

A later write failure does not roll back completed writes. The failure reports which Resources were already written. `editText()` remains the one-Resource form of the same contract.

A claimed Resource or anchor failure is terminal. Only `not-handled` continues to the next resolver.

## Built-in search

The built-in `search` tool finds exact text ranges and registers `SEARCH#HASH:N` selection anchors. A complete `SEARCH#HASH:all` anchor can expand one mutation across every matched Resource.

## Extensions

Standard anchor formats are optional extensions:

- `pi-agent-text-anchor-line-hash` registers the major `LINE#HASH` resolver and matching read prefix;
- `pi-agent-text-anchor-constant` registers `begin` and `end` as constant line selectors;
- `pi-agent-ide-ast` registers auxiliary scope anchors and matching sparse read markers.

Read presentation and edit resolution are separate registrations. A domain extension may register both and share local functions or state.

## Invariants

1. Read and editor Resource registries are independent.
2. Anchor contracts contain no tool or mutation semantics.
3. Every resolved anchor keeps one existing base line; selection ranges also stay inside that Resource.
4. A global anchor expands all of its Resources before any mutation starts.
5. Every edit uses one anchor registry snapshot and one current text snapshot per declared Resource.
6. Resolver failure, malformed output, and out-of-range positions are terminal.
7. Anchor descriptions come from active resolvers and are rendered only for active editor tools.
8. Source-specific persistence remains inside the Resource.
9. The editor reads and writes through the same Resource object.
10. Completion notifications describe committed text but are never retained as editor history.

## Batch recovery

Batch execution and recovery stay outside `TextEditorCore.executeEdit()`. The batch package owns execution progress and exactly-once coordination, while the editor integration owns resource dependency policy. See [Batch recovery](./batch-recovery.md) for the state model and retry rules.
