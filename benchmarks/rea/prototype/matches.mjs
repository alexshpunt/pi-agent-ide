/** Yield exact UTF-16 ranges for a literal query; punctuation and colon-bearing IPC names stay literal. */
export function* literalMatches(text, query, { caseSensitive = false, wholeWord = false } = {}) {
  if (!query || /[\r\n]/.test(query))
    throw new Error("REA Search needs one non-empty literal line");
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  const word = /[\p{L}\p{N}_]/u;
  for (const [index, lineText] of text.split(/\r\n|\n|\r/).entries()) {
    for (const hit of lineText.matchAll(pattern)) {
      const startColumn = hit.index;
      const endColumn = startColumn + hit[0].length;
      if (
        wholeWord &&
        (word.test([...lineText.slice(0, startColumn)].at(-1) ?? "") ||
          word.test([...lineText.slice(endColumn)][0] ?? ""))
      )
        continue;
      yield { lineNumber: index + 1, startColumn, endColumn, matchedText: hit[0], lineText };
    }
  }
}
