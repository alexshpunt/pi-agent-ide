const editorGuide = `
Read-only helpers (same arguments as standalone tools):
read({path, offset?, limit?, views?})
search({query, path?, include?, exclude?, caseSensitive?, wholeWord?, limit?})
diff({before, after})
result(value)

Transactional editor:
const file = open(path | {path, views?})
file.source; file.content; file.lines
file.find(text)                 // immutable SelectionSet with every exact match, including zero
file.select(searchMatch)        // one-range SelectionSet
file.between(start, end, {inside?: boolean}) // every sequential non-overlapping pair
file.line(first, last?)         // one-range SelectionSet
file.replace(textOrSet, replacement)
file.remove(textOrSet)
file.insertBefore(textOrSet, text)
file.insertAfter(textOrSet, text)
copy(sourceSet, destinationSet)
move(sourceSet, destinationSet)
createFile(path, content)
deleteFile(path)
copyFile(path, target, {overwrite?: boolean})
moveFile(path, target, {overwrite?: boolean})
flush()

open() returns an immutable snapshot. Selection helpers return immutable snapshot-bound SelectionSets. find() returns zero or more ranges; an empty result is not an error. Mutation methods accept a direct string or SelectionSet and stage one operation for every selected range. A direct string uses every configured in-document resolver in standalone order: structured anchors first, then exact text fallback. Resolver rejection does not fall through to literal text. Position-only anchors select their natural whole line. An empty set stages a non-applying warning; exact-query provenance can include fuzzy recovery candidates and fresh line anchors. Recovery never applies a guessed edit.

All selections in one transaction refer to the current opened snapshots, so earlier staged edits never shift later selections. After each checkpoint, opened file handles refresh to actual post-outcome contents and lines; SelectionSets created before that checkpoint become stale. copy() and move() concatenate source ranges in document order and replicate that payload at every destination range. move() stages destination effects before source removals. Whole-file copyFile() and moveFile() remain separate.

Pending operations commit once when the JavaScript completes normally. If the script throws, pending operations do not commit. Use flush() as an optional mid-script checkpoint. Operations run in staging order: the first valid overlapping operation wins, and later conflicts fail without undoing independent work. Check every per-operation outcome and retry only failed or blocked work. When a checkpoint changes a file, it creates one session-scoped APPLY# receipt. Explicit flush() returns it; automatic finalization reports it in the tool result. Pass the receipt to undo({ transaction: "APPLY#..." }) before any successfully changed path changes to restore all successful effects. After flush(), reuse the same opened handles and create fresh SelectionSets. Every checkpoint clears all staged operations, including failed operations and warnings. With no pending mutations, completion creates no transaction or receipt.

Before each operation the host verifies snapshots, resource types, ranges, overlaps, source existence, and destination conflicts. A failed operation changes nothing when rollback completes. If rollback is incomplete, its effect is unknown and later dependent operations are blocked. Do not describe an unknown effect as success.

Use find() for all exact occurrences, between() for sequential delimited ranges, select() for search results, and line() only when line identity is part of the task. Use direct strings when a configured anchor or unique exact-text fallback should select one target within the opened snapshot. Generate replacement text with ordinary JavaScript.

Example:
const config = open("src/config.ts");
const test = open("tests/config.test.ts");
config.replace("legacyMode", "stableMode");
test.replace(test.find("legacyMode"), "stableMode");
// Normal completion commits both staged edits.

Read accepts file paths, URLs, temp/search/debug/shell/diagnostics/symbol/graph resources, and supported views. Search accepts literal, regex:, files:, ast:, and symbols: queries. File changes and read-only calls are shown automatically. Use result(value) only to expose additional calculated data; do not call it merely to display committed changes.

Do not retry by guessing argument names. Inspect structured error codes such as EMPTY_SELECTION, STALE_SNAPSHOT, INVALID_TRANSACTION, and TRANSACTION_FAILED.
`;

/** Agent-facing guide for the guarded Apply editor. */
export function applyHelperGuide(): string {
  return editorGuide;
}
