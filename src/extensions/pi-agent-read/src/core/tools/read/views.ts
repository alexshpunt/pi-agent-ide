import type { TextDocument, TextLinePresenter } from "pi-agent-text";

/**
 * Built-in `lines` view: prefixes every line with its absolute 1-based number,
 * padded to the widest number in the document.
 */
export function createLineNumberPresenter(): TextLinePresenter {
  return {
    id: "line-numbers",
    present(document: TextDocument): TextDocument {
      if (document.lines.length === 0) {
        return document;
      }

      const width = Math.max(...document.lines.map((line) => String(line.lineNumber).length));
      const lines = document.lines.map((line) => ({
        ...line,
        presentation: {
          ...line.presentation,
          prefix: `${String(line.lineNumber).padStart(width)}|${line.presentation?.prefix ?? ""}`,
          compactPrefix:
            line.presentation?.compactPrefix ?? `${String(line.lineNumber).padStart(width)} │ `,
        },
      }));

      return { ...document, lines };
    },
  };
}
