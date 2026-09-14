const editorGuide = `
Read-only helpers (same arguments as standalone tools):
read({path, offset?, limit?, views?})
search({query, path?, include?, exclude?, caseSensitive?, wholeWord?, limit?})
diff({before, after})
result(value)

Transactional editor:
const file = open(path | {path, views?})
file.source; file.content; file.lines
file.find(text)                 // exactly one match or an error
file.findAll(text)              // stable selections from the original snapshot
file.select(searchMatch)        // text, regex, or AST search match
file.between(start, end, {inside?: boolean})
file.line(first, last?)
file.replace(selection, text)
file.remove(selection)
file.insertBefore(selection, text)
file.insertAfter(selection, text)
file.replaceAll(text, replacement)
createFile(path, content)
deleteFile(path)
copyFile(path, target, {overwrite?: boolean})
moveFile(path, target, {overwrite?: boolean})
apply()

open() returns an immutable snapshot. Selection methods produce snapshot-bound ranges. Mutation methods only stage changes; they do not modify files. All selections in one transaction refer to the original snapshots, so earlier staged edits never shift later selections. Missing or ambiguous exact matches and overlapping selections reject the transaction.

Call apply() explicitly to validate and commit all staged text and file operations together. One transaction may affect several files. A successful commit returns a session-scoped APPLY# receipt; pass it to undo({ transaction: "APPLY#..." }) before any touched path changes to restore the whole transaction. After a successful apply(), old editor handles are stale; call open() again for another transaction. A script may commit several transactions, and later reads observe earlier commits. Staged operations left without apply() do not change files and are reported as uncommitted.

Before each commit the host verifies snapshots, resource types, ranges, overlaps, source existence, and destination conflicts. A preflight failure changes nothing. If execution fails after writing begins, the host restores captured resources and reports whether rollback completed. Do not describe an incomplete rollback as atomic success.

Use find() for one expected occurrence, findAll()/replaceAll() for intentional repeated edits, between() for a uniquely delimited block, and line() only when line identity is genuinely part of the task. Generate replacement text with ordinary JavaScript, but never rebuild and submit a complete existing file.

Example:
const config = open("src/config.ts");
const test = open("tests/config.test.ts");
config.replace(config.find("legacyMode"), "stableMode");
test.replaceAll("legacyMode", "stableMode");
apply();

Read accepts file paths, URLs, temp/search/debug/shell/diagnostics/symbol/graph resources, and supported views. Search accepts literal, regex:, files:, ast:, and symbols: queries. File changes and read-only calls are shown automatically. Use result(value) only to expose additional calculated data; do not call it merely to display committed changes.

Do not retry by guessing argument names. Inspect structured error codes such as NOT_FOUND, AMBIGUOUS_MATCH, STALE_SNAPSHOT, INVALID_TRANSACTION, and TRANSACTION_FAILED.
`;

/** Agent-facing guide for the guarded Apply editor. */
export function applyHelperGuide(): string {
  return editorGuide;
}
