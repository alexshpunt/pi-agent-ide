/** Shared editing workflows owned by enabled mutation tools. */
export const EDITING_GUIDELINES = [
  "Read only what you need: search for known text, find code by structure with ast_search or by symbol with lsp_search, and reuse anchors you already have.",
  "Select with an anchor when you have one, otherwise with the shortest unique exact text.",
  "Send independent edits as parallel calls in one response; each sees the files as they were before the batch, so merge overlapping edits into one. Use Codemode when an edit depends on another's result. Retry only the edits that failed.",
  "Read, search and edit tools compose: pass an unchanged result to the next tool to narrow it or act on it. For example, read a function, search that result for a call, then replace that match.",
  "In Codemode, edit different files concurrently and the same file in order.",
] as const;
