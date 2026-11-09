import {
  documentLineAnchors,
  getTextSourceLine,
  type TextLine,
  type TextLinePresenter,
} from "pi-agent-text";

export function createLineHashPresenter(): TextLinePresenter {
  return {
    id: "line-hash",
    present(document, context) {
      const physical =
        (context.resolvedBy === "filesystem" || context.resolvedBy === "ssh") &&
        ((context.purpose === "edit-diff" && context.sourceText === undefined) ||
          context.sourceText === document.content);
      // Anchors name content, so a physical document needs the whole text, not only shown lines.
      const physicalAnchors = physical ? documentLineAnchors(document.lines) : undefined;
      const anchorFor = (line: TextLine) => {
        if (physicalAnchors !== undefined) {
          const anchor = physicalAnchors[line.lineNumber - 1];
          return anchor === undefined ? undefined : { anchor, lineNumber: line.lineNumber };
        }
        const sourceLine = getTextSourceLine(line);
        return sourceLine?.anchor === undefined
          ? undefined
          : { anchor: sourceLine.anchor, lineNumber: sourceLine.lineNumber };
      };
      const shown = context.lineNumbers;
      const presented = document.lines.map((line) =>
        shown === undefined || shown.has(line.lineNumber) ? anchorFor(line) : undefined,
      );
      // Pad shown lines as if the whole document were presented, so they match Read.
      const lastLine = shown === undefined ? undefined : document.lines.at(-1);
      const last = lastLine === undefined ? undefined : anchorFor(lastLine);
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
          anchors: [...new Set([...(line.anchors ?? []), item.anchor])],
          presentation: {
            ...line.presentation,
            prefix: `${item.anchor}|${line.presentation?.prefix ?? ""}`,
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
