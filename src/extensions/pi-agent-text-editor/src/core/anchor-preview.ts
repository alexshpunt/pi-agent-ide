import type { ReadRequest } from "pi-agent-read/api/tools/read";
import { documentLineAnchors, type TextDocument } from "pi-agent-text";

const MAX_LINE_LENGTH = 120;

/** Preview a source line without asking the agent to copy truncated text as a selector. */
export function previewAnchoredLine(anchor: string, content: string): string {
  const preview =
    content.length > MAX_LINE_LENGTH ? `${content.slice(0, MAX_LINE_LENGTH)}…` : content;
  return `${anchor}|${preview}`;
}

export function anchoredLinePreviews({ lines }: TextDocument) {
  const anchors = documentLineAnchors(lines);
  return {
    anchors,
    line(lineNumber: number): string | undefined {
      const anchor = anchors[lineNumber - 1];
      const line = lines[lineNumber - 1];
      return anchor === undefined || line === undefined
        ? undefined
        : previewAnchoredLine(anchor, line.content);
    },
  };
}

export function anchoredReadCall(
  path: string,
  window?: Pick<ReadRequest, "offset" | "limit">,
): string {
  return `read(${JSON.stringify({ path, ...window, views: ["anchors"] })})`;
}
