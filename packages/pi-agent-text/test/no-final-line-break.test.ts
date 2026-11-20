import { describe, expect, test } from "vitest";

import { endsWithNoFinalLineBreakMarker, NO_FINAL_LINE_BREAK } from "pi-agent-text";

describe("endsWithNoFinalLineBreakMarker", () => {
  test.each([
    NO_FINAL_LINE_BREAK,
    `${NO_FINAL_LINE_BREAK}\n`,
    `${NO_FINAL_LINE_BREAK}\r\n`,
    `text\n${NO_FINAL_LINE_BREAK}`,
    `text\r\n${NO_FINAL_LINE_BREAK}\r\n`,
  ])("finds the marker as the last line of %j", (text) => {
    expect(endsWithNoFinalLineBreakMarker(text)).toBe(true);
  });

  test.each([
    "",
    "text",
    `${NO_FINAL_LINE_BREAK}\ntext`,
    `text ${NO_FINAL_LINE_BREAK}`,
    `${NO_FINAL_LINE_BREAK} `,
    `${NO_FINAL_LINE_BREAK}\n\n`,
  ])("ignores a marker that is not alone on the last line of %j", (text) => {
    expect(endsWithNoFinalLineBreakMarker(text)).toBe(false);
  });
});
