import {
  documentLineAnchors,
  documentSelectedLineAnchors,
  getTextSourceLine,
  type TextLine,
  type TextLinePresenter,
} from "pi-agent-text";

import type { LineHashRangeHistory } from "./range-history.ts";

export function createLineHashPresenter(history?: LineHashRangeHistory): TextLinePresenter {
  return {
    id: "line-hash",
    present(document, context) {
      const physical =
        (context.resolvedBy === "filesystem" || context.resolvedBy === "ssh") &&
        ((context.purpose === "edit-diff" && context.sourceText === undefined) ||
          context.sourceText === document.content);
      const shown = context.lineNumbers;
      // Uniqueness and landmarks are determined from the whole file, but a window only needs
      // tokens for the lines it exposes. Full-document consumers still use the cached array.
      const full =
        physical && shown === undefined ? documentLineAnchors(document.lines) : undefined;
      const selected =
        physical && shown !== undefined
          ? documentSelectedLineAnchors(
              document.lines,
              new Set([...shown].map((number) => number - 1)),
            )
          : undefined;
      const physicalAnchorAt = (index: number) => full?.[index] ?? selected?.get(index);
      if (physical) {
        history?.record(context.source, document, physicalAnchorAt, shown);
      }
      const anchorFor = (line: TextLine) => {
        if (physical) {
          const anchor = physicalAnchorAt(line.lineNumber - 1);
          return anchor === undefined ? undefined : { anchor, lineNumber: line.lineNumber };
        }
        const sourceLine = getTextSourceLine(line);
        return sourceLine?.anchor === undefined
          ? undefined
          : { anchor: sourceLine.anchor, lineNumber: sourceLine.lineNumber };
      };
      // Pad shown lines as if the whole document were presented, without spreading one argument
      // per line into Math.max (which exceeds V8's argument limit on large documents).
      const lastLine = shown === undefined ? undefined : document.lines.at(-1);
      const lastNumber = physical
        ? lastLine?.lineNumber
        : lastLine && anchorFor(lastLine)?.lineNumber;
      let lineWidth = String(lastNumber ?? "").length;
      for (const line of document.lines) {
        if (shown !== undefined && !shown.has(line.lineNumber)) continue;
        const item = anchorFor(line);
        lineWidth = Math.max(lineWidth, String(item?.lineNumber ?? "").length);
      }
      const lines = document.lines.map((line) => {
        const item =
          shown === undefined || shown.has(line.lineNumber) ? anchorFor(line) : undefined;

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
