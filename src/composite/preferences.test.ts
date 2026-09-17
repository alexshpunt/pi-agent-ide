import { expect, test } from "vitest";
import { AGENT_IDE_PREFERENCES } from "./preferences.js";
import { effectiveToolPresentation, toolPresentation } from "./presentation.js";

const presentationIds = ["ui.applyPreview", "ui.diffs", "ui.read", "ui.search", "ui.terminal"];

test("tool presentation choices are available in UI settings with compact defaults", () => {
  const preferences = presentationIds.map((id) =>
    AGENT_IDE_PREFERENCES.find((preference) => preference.id === id),
  );

  expect(preferences).toHaveLength(5);
  for (const preference of preferences) {
    expect(preference).toMatchObject({ kind: "choice", group: "ui", default: "compact" });
    if (preference?.kind === "choice")
      expect(preference.values.map(({ value }) => value)).toEqual(["full", "compact", "disabled"]);
  }
});

test("expanded overrides stored presentation and invalid values use compact", () => {
  expect(toolPresentation("unknown")).toBe("compact");
  expect(effectiveToolPresentation("disabled", true)).toBe("full");
  expect(effectiveToolPresentation("disabled", false)).toBe("disabled");
});
