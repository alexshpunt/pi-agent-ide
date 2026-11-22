import { endsWithNoFinalLineBreakMarker, NO_FINAL_LINE_BREAK } from "pi-agent-text";

import { TextMutationInputError } from "#src/api/mutation-tool.ts";

/**
 * Refuses text whose last line is the marker that Read and mutation results show after a file
 * without a final line break. The marker is display only, so writing it would put it in the file.
 */
export function refuseEndOfFileMarker(text: string): void {
  if (!endsWithNoFinalLineBreakMarker(text)) return;
  throw new TextMutationInputError(
    "END_OF_FILE_MARKER",
    `Nothing was changed. The last line of text is the display marker "${NO_FINAL_LINE_BREAK}", which Read and results show after a file that has no final line break; it is not file content. Remove that line and retry: the tools keep the end of the file as it is.`,
  );
}
