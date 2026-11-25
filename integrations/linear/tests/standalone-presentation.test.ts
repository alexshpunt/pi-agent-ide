import { expect, test } from "vitest";
import { safeTerminalText, standalonePresentation } from "#linear/standalone-presentation.ts";

test("remote terminal control sequences never reach the user renderer", () => {
  expect(safeTerminalText("before\u001b[2J\u001b]0;hostile title\u0007after\n")).toBe(
    "beforeafter\n",
  );
});

test("the human sees a cause and next action instead of an internal error dump", () => {
  const shown = standalonePresentation(
    "LINEAR_SNAPSHOT_UNVERIFIED",
    {
      code: "LINEAR_SNAPSHOT_UNVERIFIED",
      effect: "not-applied",
      source: "linear://example/issue/ENG-1/description",
    },
    true,
    false,
  );
  expect(shown).toContain("Read this body or field before changing it.");
  expect(shown).toContain("No change was made.");
  expect(shown).not.toContain("LINEAR_");
  expect(
    standalonePresentation("private backend dump", { effect: "unknown" }, true, true),
  ).toContain("Delivery is uncertain.");
  expect(
    standalonePresentation("private backend dump", { effect: "unknown" }, true, true),
  ).not.toContain("private backend dump");
});
