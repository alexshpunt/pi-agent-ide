/** Standalone-independent guide for the JavaScript helpers exposed by Apply. */
export const applyHelperGuide = `
Helper arguments (one object per call; ? means optional):
read({path: string, offset?: number, limit?: number, views?: string[]})
search({query: string, path?: string, include?: string, exclude?: string, caseSensitive?: boolean, wholeWord?: boolean, limit?: number})
diff({before: string | {path: string, offset?: number, limit?: number, views?: string[]}, after: string | {path: string, offset?: number, limit?: number, views?: string[]}})
write({path: string, content: string})
replace({path?: string, start?: string, end?: string, text: string})
insert({path?: string, anchor?: string, text: string, before?: boolean})
remove({path?: string, start?: string, end?: string})
copy({path?: string, start?: string, end?: string, target?: string, targetStart?: string, targetEnd?: string})
move({path?: string, start?: string, end?: string, target?: string, targetStart?: string, targetEnd?: string})
delete_file({path: string})
copy_file({path: string, target: string, overwrite?: boolean})
move_file({path: string, target: string, overwrite?: boolean})
undo({file?: string, change: string})
stage({file: string, change: string})
unstage({file: string, change: string})
result(value)

Whole-file helpers operate on local regular files. Configured post-processing can format copied or moved UTF-8 text targets; binary contents remain unchanged. delete_file permanently deletes a file; copy_file copies it; move_file moves or renames it. Directories and symlinks are rejected. Existing targets require overwrite: true. Use the same names and arguments for standalone calls and inside Apply; only the text delete tool is named remove inside JavaScript. Receipts contain kind: "file-operation", operation, ok, effect, path, target?, error?. An unknown effect requires inspection before retry; no automatic rollback.

Writes take effect immediately. Final post-processing runs once per surviving changed file when Apply finishes, including after a script error; automatic diagnostics follow final processing. Reads inside the script see current, not yet finally formatted text. Re-read final anchors in a later call when needed. Stage captures the current bytes, before end-of-Apply formatting. Explicit diagnostic reads still request checks at their call site.

Use path, not file_path. Pass a source to read; offset/limit select lines, not character ranges, except raw: sources where they select bytes. Negative offsets start from the end. Use views such as anchors, ast, diagnostics or changes. Sources also accept file://, HTTP(S), temp:, SEARCH#, ast:, diagnostics:, symbol: and graph: forms supported by read. Explicit diagnostic requests wait; an ordinary read does not.
Use read({path: "raw:local-file", offset: 0, limit: 64}) to inspect original bytes without conversion. In raw: reads, offset is a zero-based byte position (negative from EOF) and limit is a non-negative byte count; omit limit for all remaining bytes in the script. Raw reads return {kind: "bytes", source, byteOffset, byteLength, totalBytes, bytes: number[], ok}. Use result(doc) to display hex + ASCII. No views, text anchors or byte editing are supported.
Search query accepts literal text, Boolean conditions, regex:, files:, ast: and symbols:. limit is 1–1000. Reuse returned SEARCH references; do not invent session IDs. Search returns {resolverId, data, details, ok}; details contains resolver-specific selection metadata.
Use ast:<pattern> search for structural edits. Pass its returned SEARCH#...:N:match as path to replace, copy, move or remove; the selection covers the exact node, including multiline boundaries. Single references become stale after file changes; all selections rerun the original AST query and require complete results. Use data.matches and their metaVariables to compute replacement text. These are text edits, not reference-aware refactors. Use path/include/exclude to scope symbols: searches before the result limit is applied.
Text read returns {kind: "text", source, content: string, lines, startLine, endLine, totalLines, ok}. Each line contains content, lineNumber, lineEnding, anchors and available metadata. Native reads return {kind: "native", source, blocks, ok}; multi-source reads return {kind: "resources", resources, ok}. Check kind before using text-only fields.
Use unique exact text or an anchor returned by read/search for start, end and anchor. A whole-line anchor selects its line; end includes its final line. Omit end for a single selected fragment. begin/end are file-boundary anchors. Omit path only when a previous read/edit or a SEARCH reference identifies the source. A SEARCH selection may also supply the range without start/end. Insert goes after the selected line unless before:true. Copy/move target defaults to source; targetStart selects the destination, and targetEnd replaces an inclusive target line range instead of inserting after targetStart. remove deletes selected text, not a file. write creates or replaces the entire file.
Use symbol:<file>#<selector> as a declaration selection for copy, move, remove or replace when the LSP plugin is available. For example, copy({path: "symbol:src/a.ts#Example", target: "src/b.ts", targetStart: "end"}). Select parent/child for ambiguous names. Supply an explicit target for copy/move. This declaration-text fallback does not update imports or references; metadata.semanticEdit reports that limitation. Semantic insert is unsupported. Do not treat declaration replacement as a semantic rename.
Use replace({path: "symbol:src/a.ts#Example#name", text: "NewName"}) for native LSP rename, including references. Omit start/end. The #name suffix selects semantic rename rather than declaration replacement. If the server cannot rename, handle the failure; no identifier-text fallback is applied.
Use result(doc) to explicitly keep a read result with its source and presentation. Do not use result(doc.content) merely to display a read: it adds a separate raw string and loses the source/view information. Read-only calls are shown automatically, so mass reads need no result calls. Use result(value) for additional computed data; explicit additions survive mutations. Mutations return {operation, ok, effect, files, completed, errors, recoveries?, metadata?}; files contain source, before, after, changes and formatting. They are reported automatically as final per-file changes.

Use diff to compare text-readable sources without editing them. Each side accepts a source string or read request. The result is {kind: "diff", ok, equal, before: {source, sources, content}, after: {source, sources, content}, diff, stats: {added, removed}}. Multiple resources are joined with one newline in resolver order. Patch line numbers are relative to the selected text. Comparisons are automatic read-only output; use result(comparison) to keep one when the script also edits files.
Use stage/unstage with a current CHANGE# anchor from read({path: file, views: ["changes"]}) to change only the Git index. These operations return {kind: "index-operation", operation, ok, effect: "index-only", file, change, state, unchanged} and keep worktree content. Use undo({file, change: "last"}) to restore that file before its latest text-editor transaction, not the entire Apply call. Use undo({file, change: "CHANGE#..."}) to restore a selected change to HEAD in both worktree and index. Git operations require the Git changes module. Re-read stale changes before retrying; completed operations survive later failures.
Examples:
const doc = read({path: "src/example.ts"});
const line = doc.lines.find(line => line.content.includes("oldValue"));
if (line) replace({path: doc.source, start: line.anchors[0], text: line.content.replace("oldValue", "newValue")});

for (const path of ["README.md", "package.json"]) read({path});

Do not retry by guessing different argument names. Catch errors and inspect code/details; distinguish invalid arguments, unavailable services and stale/ambiguous anchors. Already applied edits remain applied.
`;
