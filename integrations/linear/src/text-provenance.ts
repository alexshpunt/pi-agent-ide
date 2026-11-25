import { textLineAnchors, withTextSourceLine } from "pi-agent-ide/api/text";
import type { ReadHandler } from "pi-agent-ide/api/read";
import { parseTextAddress } from "./text-address.ts";
import { parseLinearFieldAddress } from "./fields.ts";
import { isLinearCommentBodySource } from "./comment-resource.ts";

/** Mark only verified, unchanged body lines for the shared anchor presenter. */
export const linearBodyProvenance: ReadHandler = (context) => {
  const state = context.state;
  if (state?.contentKind !== "text" || context.sourceText !== state.text.content)
    return { kind: "continue", context };
  const address = parseTextAddress(state.source);
  const field = parseLinearFieldAddress(state.source);
  if (
    (!address || address.kind === "create-document" || address.kind === "create-comment") &&
    !field?.facet &&
    !isLinearCommentBodySource(state.source)
  )
    return { kind: "continue", context };
  // The shared presenter can only issue anchors mapped back to the complete source.
  const anchors = textLineAnchors(state.source, state.text.content);
  return {
    kind: "continue",
    context: {
      ...context,
      state: {
        ...state,
        text: {
          ...state.text,
          lines: state.text.lines.map((line) => {
            const anchor = anchors.at(line.lineNumber - 1);
            return withTextSourceLine(line, {
              source: state.source,
              lineNumber: line.lineNumber,
              content: line.content,
              ...(anchor === undefined ? {} : { anchor }),
            });
          }),
        },
      },
    },
  };
};
