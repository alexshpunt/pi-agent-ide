/**
 * The editor ends a line at LF only; CR is an ordinary character. LSP positions use the same
 * lines for LF and CRLF text, because a CRLF line's CR comes after every position a server
 * names on that line. A lone CR is different: the protocol ends a line there, while some servers
 * (clangd, rust-analyzer) count LF only, so the line a position names depends on the server.
 * Positions in such a file cannot be placed without guessing, so they are refused instead.
 */
export function assertLspLines(content: string): void {
  if (/\r(?!\n)/u.test(content))
    throw Object.assign(
      new Error(
        "This file holds a carriage return that is not followed by a line feed. Language servers disagree about the line it ends, so its LSP positions cannot select exact text. Use text search for this file.",
      ),
      { code: "LSP_AMBIGUOUS_LINE_BREAK" },
    );
}
