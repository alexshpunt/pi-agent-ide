import { getTextSourceLine, type TextLinePresenter } from "pi-agent-text";

import { createLineHashAnchor } from "./anchor.js";

export function createLineHashPresenter(): TextLinePresenter {
  return {
    id: "line-hash",
    present(document, context) {
      const anchors = document.lines.map((line) => {
        if (context.resolvedBy === "filesystem") {
          return createLineHashAnchor(line.lineNumber, line.content);
        }

        const sourceLine = getTextSourceLine(line);

        return sourceLine === undefined
          ? undefined
          : createLineHashAnchor(sourceLine.lineNumber, sourceLine.content);
      });
      const width = Math.max(0, ...anchors.map((anchor) => anchor?.value.length ?? 0));
      const lines = document.lines.map((line, index) => {
        const anchor = anchors[index];

        if (anchor === undefined) {
          return line;
        }

        return {
          ...line,
          presentation: {
            ...line.presentation,
            prefix: `${anchor.value.padStart(width)}|${line.presentation?.prefix ?? ""}`,
          },
        };
      });

      return { ...document, lines };
    },
  };
}
