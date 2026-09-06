import { getTextSourceLine, type TextLinePresenter } from "pi-agent-text";

import { createLineHashAnchor } from "./anchor.js";

export function createLineHashPresenter(): TextLinePresenter {
  return {
    id: "line-hash",
    present(document, context) {
      const presented = document.lines.map((line) => {
        const sourceLine =
          context.resolvedBy === "filesystem"
            ? { lineNumber: line.lineNumber, content: line.content }
            : getTextSourceLine(line);
        return sourceLine === undefined
          ? undefined
          : {
              anchor: createLineHashAnchor(sourceLine.lineNumber, sourceLine.content),
              lineNumber: sourceLine.lineNumber,
            };
      });
      const anchorWidth = Math.max(0, ...presented.map((item) => item?.anchor.value.length ?? 0));
      const lineWidth = Math.max(
        0,
        ...presented.map((item) => String(item?.lineNumber ?? "").length),
      );
      const lines = document.lines.map((line, index) => {
        const item = presented[index];

        if (item === undefined) {
          return line;
        }

        return {
          ...line,
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
