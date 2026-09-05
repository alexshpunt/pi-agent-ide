import { defineRule } from "@oxlint/plugins";

/**
 * Matches a dot-dot path segment in raw source text:
 * - dot-dot followed by a separator (traversal at the start of a path)
 * - a separator followed by dot-dot (segment inside a path)
 * - a bare quoted dot-dot (for example passed to path.join)
 *
 * A leading dot before the segment (an ellipsis) never matches.
 */
const parentSegment = /(?<!\.)\.\.\/|(?<!\.)\/\.\.(?![.\w])|['"`]\.\.['"`]/gu;

/** Ban paths that traverse up; go deeper or use absolute/root-relative paths. */
export const noParentPathsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow parent traversal via dot-dot segments in any path; use absolute, root-relative, or downward-relative paths.",
    },
    messages: {
      parentPath:
        "Path traverses up with a dot-dot segment. Use an absolute or root-relative path, or a path deeper from the current location.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const match of text.matchAll(parentSegment)) {
          const index = match.index ?? 0;
          const { line, column } = lineColumn(text, index);
          context.report({
            messageId: "parentPath",
            loc: { start: { line, column }, end: { line, column: column + 2 } },
          });
        }
      },
    };
  },
});

function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline - 1 };
}
