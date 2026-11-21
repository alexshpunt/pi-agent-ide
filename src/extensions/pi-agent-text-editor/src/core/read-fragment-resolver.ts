import { requiredValue } from "pi-agent-invariant";
import type {
  FragmentResolverRegistration,
  ReadFragmentContext,
} from "pi-agent-read/api/tools/read";
import { linesWithAnchor, type TextAnchor } from "pi-agent-text";
import { anchoredLinePreviews, anchoredReadCall } from "./anchor-preview.ts";

import type { TextAnchorInTextRequest } from "#src/core/text-editor-core.ts";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.ts";

/** Anything that can resolve an anchor value against provided text content. */
export interface ReadFragmentAnchorSource {
  resolveAnchorInText(request: TextAnchorInTextRequest): Promise<TextAnchor>;
}

/** Maximum recovery candidates shown in a read failure message. */
const MAX_SHOWN_CANDIDATES = 5;

/**
Builds the read fragment resolver backed by the editor anchor registry.

The resolver maps an anchored read's `#fragment` to the first line of its
match, reusing exactly the same resolution chain and failure candidates as
the edit tools.
*/
export function createReadFragmentResolver(
  core: ReadFragmentAnchorSource,
): FragmentResolverRegistration {
  return {
    id: "text-editor-anchors",
    async resolve(context) {
      let anchor: TextAnchor;

      try {
        anchor = await core.resolveAnchorInText({
          source: context.source,
          content: context.text.content,
          value: context.fragment,
          cwd: context.cwd,
          ...(context.signal !== undefined && { signal: context.signal }),
        });
      } catch (error) {
        if (error instanceof TextAnchorResolutionError) {
          // Core defers resolver recovery; run it now so read failures carry candidates.
          await error.refreshRecovery();
        }

        return { kind: "failed", message: describeAnchorError(error, context) };
      }

      return { kind: "resolved", originLine: anchorOriginLine(anchor) };
    },
  };
}

function anchorOriginLine(anchor: TextAnchor): number {
  if (TextSelectionAnchor.is(anchor)) {
    return requiredValue(anchor.ranges[0]).start.lineNumber;
  }

  return anchor.lineNumber;
}

function describeAnchorError(error: unknown, { source, text }: ReadFragmentContext): string {
  if (!(error instanceof TextAnchorResolutionError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const parts = [error.message];
  const recovery = error.recovery;
  let path = source;

  if (recovery?.kind === "candidates" && recovery.candidates.length > 0) {
    const previews = anchoredLinePreviews(text);
    const lines = new Set(recovery.candidates.map(({ range }) => range.start.lineNumber));
    let shown = 0;
    for (const lineNumber of lines) {
      const row = previews.line(lineNumber);
      if (row === undefined) continue;
      if (shown === 0) parts.push("Candidates:");
      parts.push(row);
      const anchor = previews.anchors[lineNumber - 1];
      if (
        path === source &&
        anchor !== undefined &&
        linesWithAnchor(previews.anchors, anchor).length === 1
      )
        path = `${source}#${anchor}`;
      if (++shown === MAX_SHOWN_CANDIDATES) break;
    }
    const hidden =
      recovery.total - recovery.candidates.length + Math.max(0, lines.size - MAX_SHOWN_CANDIDATES);
    if (hidden > 0) parts.push(`… ${hidden} more matches.`);
  }

  parts.push(`Try ${anchoredReadCall(path)}.`);
  return parts.join("\n");
}
