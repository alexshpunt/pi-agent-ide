# Apply scripting reference

## Before using Apply

Read this guide before writing an Apply script. Use Apply only for computed or conditional edits, selection composition, explicit checkpoints, or one coherent cross-file transaction.

When each change is already known and independent, use standalone text tools instead. Submit those tools together in one assistant response; they share the original file snapshots and work for several edits in one file or across files. Do not write a JavaScript Apply program merely to group straightforward replacements, insertions, removals, copies, or moves. Read `docs:editing` for that workflow.

Open every source first, select from immutable snapshots, stage operations, and let normal completion commit once. A thrown script commits no pending operations. Check every operation outcome: independent valid edits may succeed when another edit is rejected. Keep each returned `APPLY#` receipt for atomic undo of that checkpoint.

## Choosing a selection

Choose boundaries from the request's source of truth. Prefer content-based selections when content identifies the target:

1. Use `find` for exact occurrences.
2. Use `between` for blocks identified by opening and closing content.
3. Use `select` for a structured search result.
4. Use `within`, `slice`, or `union` to narrow or combine those selections.
5. Use `linesOf` or `between(..., { lines: true })` when the operation must include complete lines.
6. Use `line(first, last)` only when the user supplied those line numbers or you independently verified both inclusive bounds.

Do not infer line ranges from the starting lines of nearby blocks. Do not include a following blank line unless the requested change includes that separator.

Selections are immutable and belong to one file snapshot. A flush refreshes open documents and makes earlier selections stale. Build new selections after each checkpoint.

## Read-only helpers

### `read({...})`

Use it to inspect a resource from inside an Apply script. It accepts the same arguments as the standalone Read tool and records its result automatically.

```js
read({ path: "config.json", offset: 1, limit: 40 });
```

Effect: reads the requested window without staging a mutation.

### `search({...})`

Use it to discover files, text, symbols, or structures before opening a document. It accepts the standalone Search arguments and records its result automatically.

```js
const matches = search({ query: '"oldName"', path: "src" });
```

Effect: returns structured matches without changing files.

### `diff({before, after})`

Use it to compare two sources before deciding what to edit. It accepts the standalone Diff arguments and records its result automatically.

```js
diff({ before: "old\n", after: "new\n" });
```

Effect: returns a read-only textual comparison.

## Opening documents

### `open(path | { path, views? })`

Use it before selecting or editing an existing text resource.

```js
const file = open("src/example.ts");
```

Effect: creates an editor handle backed by an immutable snapshot. `file.source`, `file.content`, and `file.lines` expose its source, full canonical text, and line count. Supplying `views` changes how the source is opened when that resource supports views.

## Selection primitives

### `file.find(text)`

Use it when an exact string identifies one or more targets.

```js
const names = file.find("oldName");
```

Effect: returns every exact occurrence in source order. It does not silently choose one occurrence. Use `slice` or `within` when only some occurrences are intended.

### `file.select(searchMatch)`

Use it to turn one structured Search match into a selection in its source document.

```js
const target = file.select(matches[0]);
```

Effect: maps the match's line and column range to the open snapshot. It rejects matches from another file and matches whose recorded text is stale.

### `file.between(start, end, options?)`

Use it for blocks whose boundaries are identified by content or existing selections.

```js
const block = file.between("BEGIN", "END", { lines: true });
```

Effect: pairs each start with the first end after that start, then continues with later non-overlapping pairs. By default both boundaries are included. `{ inside: true }` excludes both boundaries. `{ lines: true }` expands through the complete lines containing both boundaries, including the closing line's newline but not a following blank separator. `inside` and `lines` cannot be combined.

If repeated boundaries produce several blocks, narrow the result with `slice` rather than assuming only one pair exists.

### `file.line(first, last?)`

Use it only when the 1-based line bounds are authoritative or already verified.

```js
const header = file.line(1, 3);
```

Effect: selects complete lines from `first` through `last`, inclusive. Omitting `last` selects one line. Invalid, negative, reversed, or out-of-range bounds are rejected.

### `file.start()` and `file.end()`

Use them as zero-width destinations when `copy` or `move` should insert at the beginning or end of a document.

```js
copy(source.find("preamble"), target.start());
move(source.find("appendix"), target.end());
```

Effect: returns a zero-width linewise selection at byte zero or end of file. These are positions, not existing text.

### `file.before(selection)` and `file.after(selection)`

Use them to convert selected content into insertion positions.

```js
const destination = file.before(file.find("export default"));
```

Effect: returns zero-width positions immediately before or after every selected range. Linewise selections retain linewise insertion behavior.

### `file.slice(selection, start?, end?)`

Use it to choose occurrences by position after a broader selector has found them.

```js
const first = file.slice(file.find("token"), 0, 1);
```

Effect: returns the same ranges that normal JavaScript array `slice(start, end)` would retain. It does not alter the document.

### `file.union(...selections)`

Use it to combine separate selections from the same snapshot into one mutation target.

```js
const targets = file.union(file.find("alpha"), file.find("beta"));
```

Effect: sorts ranges, removes exact duplicates, and rejects overlaps. It never turns sparse targets into one wide range containing the text between them.

### `file.within(candidates, scopes)`

Use it to keep only candidates fully contained by selected scopes.

```js
const localNames = file.within(file.find("name"), file.between("class A", "}"));
```

Effect: returns each candidate whose complete range lies inside at least one scope.

### `file.linesOf(selection)`

Use it when content matches identify targets but the operation must affect their complete containing lines.

```js
const declarations = file.linesOf(file.find("const obsolete ="));
```

Effect: expands every range to its containing line, preserves line endings, and removes duplicate line ranges.

## Text mutations

Every text mutation stages one operation for every selected range. Empty selections produce a warning rather than a guessed edit. Global forms infer the document from the SelectionSet; document methods provide the same behavior and may also accept a directly resolvable string target.

### `replace(selection, text)` and `file.replace(target, text)`

Use them to replace selected text.

```js
replace(file.find("oldName"), "newName");
```

Effect: replaces every selected range with `text` in one transaction.

### `remove(selection)` and `file.remove(target)`

Use them to remove selected text, not files.

```js
remove(file.linesOf(file.find("obsolete();")));
```

Effect: replaces every selected range with an empty string. Use precise sparse selections instead of a broad range spanning unrelated content.

### `insertBefore(selection, text)` and `file.insertBefore(target, text)`

Use them to insert text immediately before each selected range.

```js
insertBefore(file.linesOf(file.find("function run")), "// Entry point\n");
```

Effect: keeps the selected text and inserts before it. For linewise selections, Apply supplies the needed line boundary.

### `insertAfter(selection, text)` and `file.insertAfter(target, text)`

Use them to insert text immediately after each selected range.

```js
insertAfter(file.linesOf(file.find("import value")), 'import other from "./other.js";\n');
```

Effect: keeps the selected text and inserts after it. For linewise selections, Apply supplies the needed line boundary, including at an unterminated final line.

## Moving and copying text

### `copy(source, destination)`

Use it to duplicate selected text within one file or across open files.

```js
copy(source.find("sharedValue"), target.end());
```

Effect: concatenates source ranges in selection order. A zero-width destination inserts that text; a non-empty destination replaces it. Source text remains unchanged.

### `move(source, destination)`

Use it to relocate selected text within one file or across open files.

```js
move(source.between("BEGIN", "END", { lines: true }), target.end());
```

Effect: performs the same destination insertion or replacement as `copy`, then removes every source range in the same coherent transaction. Prefer linewise selections when moving complete blocks so separators remain stable.

## Whole-file operations

### `createFile(path, content)`

Use it to create a new file from complete content.

```js
createFile("src/new.ts", "export const value = 1;\n");
```

Effect: stages creation at `path`. It does not overwrite an existing file.

### `file.delete()` and `deleteFile(path)`

Use `file.delete()` when an opened file should be deleted after its earlier staged operations. Use `deleteFile(path)` when no document handle is needed.

```js
const obsolete = open("src/obsolete.ts");
obsolete.delete();
```

Effect: stages whole-file deletion. This is distinct from `remove(selection)`, which removes text.

### `copyFile(path, target, { overwrite? })`

Use it to copy one complete file.

```js
copyFile("config.example.json", "config.json");
```

Effect: stages a file copy. An existing regular target is rejected unless `overwrite: true` is explicit.

### `moveFile(path, target, { overwrite? })`

Use it to rename or relocate one complete file.

```js
moveFile("src/old.ts", "src/new.ts");
```

Effect: stages a file move. An existing regular target is rejected unless `overwrite: true` is explicit.

## Checkpoints and transaction guarantees

### `file.flush()`

Use it to checkpoint independent operations staged for one document when later work needs a refreshed snapshot.

```js
file.replace(file.find("old"), "new");
file.flush();
```

Effect: commits that file's independent pending operations, refreshes its open handle, and makes its earlier selections stale. If the file participates in a pending cross-file `copy` or `move`, nothing for that file is flushed so the transfer keeps one coherent snapshot.

### `flush()`

Use it only when the script deliberately needs a global checkpoint before continuing.

```js
flush();
```

Effect: commits every pending operation, refreshes affected open handles, and can return an `APPLY#` receipt. Normal successful completion already performs one global flush. A later thrown error does not undo an earlier explicit checkpoint.

## Failure, ordering, and undo

Operations are evaluated against their captured snapshots, not against text shifted by earlier staged edits. This makes several non-overlapping edits safe without compensating line numbers. Overlapping or stale selections are rejected rather than guessed.

A successful checkpoint may return an `APPLY#` receipt. Restore every path touched by that checkpoint atomically with:

```js
undo({ transaction: "APPLY#..." });
```

Separate explicit checkpoints can produce separate receipts. Do not assume one receipt covers changes committed by an earlier flush.

## Standalone anchors and specialized resources

Standalone text tools support line anchors, syntax-scope anchors, search selections, and unique exact strings. With an `end` selector, they operate on complete lines through the line containing the end boundary. Without `end`, an exact string selects only that fragment.

When a standalone text tool allows an omitted path, it can inherit the source identified by its anchor, the last read, or the preceding edit in the same batch. Supply the path explicitly when that inheritance would be ambiguous.

Some resources attach non-text actions to the same tools:

- `shell:<session>` — `write` sends exact input, `insert` sends named keys, and `delete` terminates the session.
- `debug:<session>` — `insert` controls the debugger and `delete` removes a breakpoint or terminates the session.
- `symbol:<file>#<selector>#name` — `replace` performs a native language-server rename when available.

Read `docs:terminal`, `docs:debugger`, or `docs:search-code` before using those specialized resources.

Never guess after a stale snapshot, empty selection, ambiguous target, or unknown rollback effect.
