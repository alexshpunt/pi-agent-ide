/**
 * Display line that follows the last line of a text without a final line break, as a unified
 * diff shows it. It is not a line of the text: it has no anchor or number and no tool writes it.
 */
export const NO_FINAL_LINE_BREAK = "\\ No newline at end of file";

/** True when the last line of `text` is exactly the display marker, with or without a line break. */
export function endsWithNoFinalLineBreakMarker(text: string): boolean {
  const withoutBreak = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lastLine = withoutBreak.slice(withoutBreak.lastIndexOf("\n") + 1);
  return (lastLine.endsWith("\r") ? lastLine.slice(0, -1) : lastLine) === NO_FINAL_LINE_BREAK;
}
