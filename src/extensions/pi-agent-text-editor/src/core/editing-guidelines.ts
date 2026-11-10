/** Shared editing workflows owned by enabled mutation tools. */
export const EDITING_GUIDELINES = [
  "Read only what you need: search for known text, find code by structure with ast_search or by symbol with lsp_search, and reuse anchors you already have.",
  "Select text for an edit with start and end, or with anchor in insert: a line anchor from read's anchors view, scope-begin-… or scope-end-… from its ast view, a SEARCH#… reference, begin or end for the first or last line, or, without an anchor, the shortest unique exact text. A line anchor selects its whole line, including the line break. Exact text keeps its character boundaries unless start and end both match complete lines. New text follows the file's line endings.",
  "Send independent edits as parallel calls in one response; each sees the files as they were before the batch, so merge overlapping edits into one. Use Codemode when an edit depends on another's result. Retry only the edits that failed.",
  "Read, search and edit tools compose: pass an unchanged result to the next tool to narrow it or act on it. A result selects what it returned: a read its window, a search its matches, an edit its new text. For example, read a function, search that result for a call, then replace that match.",
  "In Codemode, edit different files concurrently and the same file in order.",
] as const;
