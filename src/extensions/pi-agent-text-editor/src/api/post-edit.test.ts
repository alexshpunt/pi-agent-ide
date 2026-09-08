import { expect, test } from "vitest";
import { isDiffStatusContribution } from "./post-edit.js";

test("post-edit status contributions accept plain display data and reject invalid entries", () => {
  expect(
    isDiffStatusContribution({
      diffStatuses: [{ text: "fixture" }, { text: "other", tone: "success" }],
    }),
  ).toBe(true);
  expect(isDiffStatusContribution({ diffStatuses: [] })).toBe(true);
  for (const value of [
    null,
    {},
    { diffStatuses: "fixture" },
    { diffStatuses: [{}] },
    { diffStatuses: [{ text: "" }] },
    { diffStatuses: [{ text: "fixture", tone: "invalid" }] },
  ]) {
    expect(isDiffStatusContribution(value)).toBe(false);
  }
});
