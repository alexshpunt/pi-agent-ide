const editorGuide = `
Read-only helpers use the standalone-tool arguments: read({...}), search({...}), and diff({before, after}). Their results are recorded automatically.

Transactional helpers:
open(path | {path, views?}); file.find(text); file.select(searchMatch); file.between(start, end, {inside?, lines?}); file.line(first, last?); file.start(); file.end(); file.before(selection); file.after(selection); file.slice(selection, start?, end?); file.union(...selections); file.within(candidates, scopes); file.linesOf(selection); file.replace(selection, text); file.remove(selection); file.insertBefore(selection, text); file.insertAfter(selection, text); file.flush(); file.delete(); replace(selection, text); remove(selection); insertBefore(selection, text); insertAfter(selection, text); copy(source, destination); move(source, destination); createFile(path, content); deleteFile(path); copyFile(path, target, {overwrite?}); moveFile(path, target, {overwrite?}); flush().

Selections are immutable and snapshot-bound. Use slice to select occurrences by position, union to combine non-overlapping sets, within to keep candidates contained by scopes, and linesOf to expand matches to whole lines. between accepts strings or SelectionSets as either boundary; {lines:true} expands through both containing lines. Prefer it for blocks identified by content; use line(first,last) only for exact verified line bounds. Use start/end or before/after as zero-width destinations when copy or move should insert instead of replace. Normal completion commits staged operations once; a thrown script commits none. flush() commits every staged operation; file.flush() commits only independent operations for that file while cross-file transfers stay pending. Successful checkpoints can return an APPLY# receipt. Failed operations report structured errors and do not silently guess a recovery.
`;

/** Compact callable contract for the guarded Apply editor. */
export function applyHelperGuide(): string {
  return editorGuide;
}
