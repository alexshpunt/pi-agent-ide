import { getTextSourceLine, type TextLine, type TextLinePresenter } from "pi-agent-text";

import { createLineHashAnchor } from "./anchor.ts";

export function createLineHashPresenter(): TextLinePresenter {
  return {
    id: "line-hash",
    present(document, context) {
      const physical =
        (context.resolvedBy === "filesystem" || context.resolvedBy === "ssh") &&
        ((context.purpose === "edit-diff" && context.sourceText === undefined) ||
          context.sourceText === document.content);
      const anchorFor = (line: TextLine) => {
        const sourceLine = physical
          ? { lineNumber: line.lineNumber, content: line.content }
          : getTextSourceLine(line);
        return sourceLine === undefined
          ? undefined
          : {
              anchor: createLineHashAnchor(sourceLine.lineNumber, sourceLine.content),
              lineNumber: sourceLine.lineNumber,
            };
      };
      const shown = context.lineNumbers;
      const presented = document.lines.map((line) =>
        shown === undefined || shown.has(line.lineNumber) ? anchorFor(line) : undefined,
      );
      // Pad shown lines as if the whole document were presented, so they match Read.
      const lastLine = shown === undefined ? undefined : document.lines.at(-1);
      const last = lastLine === undefined ? undefined : anchorFor(lastLine);
      const anchorWidth = Math.max(
        last?.anchor.value.length ?? 0,
        ...presented.map((item) => item?.anchor.value.length ?? 0),
      );
      const lineWidth = Math.max(
        String(last?.lineNumber ?? "").length,
        ...presented.map((item) => String(item?.lineNumber ?? "").length),
      );
      const lines = document.lines.map((line, index) => {
        const item = presented[index];

        if (item === undefined) {
          return line;
        }

        return {
          ...line,
          anchors: [...new Set([...(line.anchors ?? []), item.anchor.value])],
          presentation: {
            ...line.presentation,
            prefix: `${item.anchor.value.padStart(anchorWidth)}|${line.presentation?.prefix ?? ""}`,
            compactPrefix:
              line.presentation?.compactPrefix ??
              `${String(item.lineNumber).padStart(lineWidth)} │ `,
          },
        };
      });

      return { ...document, lines };
    },
  };
}
