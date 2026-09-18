import { requiredValue } from "pi-agent-invariant";
import type { FragmentResolverRegistration } from "pi-agent-read/api/tools/read";
import type { TextAnchor } from "pi-agent-text";

import type { TextAnchorInTextRequest } from "#src/core/text-editor-core.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.js";

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

        return { kind: "failed", message: describeAnchorError(error) };
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

function describeAnchorError(error: unknown): string {
  if (!(error instanceof TextAnchorResolutionError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const parts = [error.message];
  const recovery = error.recovery;

  if (recovery?.kind === "candidates" && recovery.candidates.length > 0) {
    for (const candidate of recovery.candidates.slice(0, MAX_SHOWN_CANDIDATES)) {
      parts.push(`Candidate: line ${candidate.range.start.lineNumber}`);
    }

    const hidden = recovery.total - Math.min(recovery.candidates.length, MAX_SHOWN_CANDIDATES);

    if (hidden > 0) {
      parts.push(`(+${hidden} more candidates)`);
    }
  }

  return parts.join("\n");
}
