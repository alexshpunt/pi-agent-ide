/** Shared editing workflows, emitted once when mutation tools are enabled. */
export const EDITING_GUIDELINES = [
  "Read only what you need: search for known text, find code by structure with ast_search or by symbol with lsp_search, and reuse anchors you already have.",
  "For edit sources, pass one path or one result selection; lists take results or references, not paths, and may combine searches. If any item is unusable, the call changes nothing and lists all errors. A result passed with start/end or anchor is their scope: they select inside its ranges. Omit an optional source to use its anchor's file or the last resolved source.",
  "Select text with start/end, or anchor in insert: a line anchor from Read's anchors view, scope-begin-… or scope-end-… from its ast view, a SEARCH# reference, begin/end for the first/last line, or the shortest unique exact text. Without end, start selects its own extent; with end, the range includes both endpoints. A line anchor includes its line break; exact text keeps character boundaries unless both endpoints match complete lines. New text follows the file's line endings.",
  "Send independent standalone edits together; each sees the original snapshots, so merge overlapping edits into one. In Codemode, edit different files concurrently and the same file in order. Retry only failed edits.",
] as const;
