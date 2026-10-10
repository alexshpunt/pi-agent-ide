import { expect, test } from "vitest";
import { AGENT_IDE_PREFERENCES } from "./preferences.js";
import { effectiveToolPresentation, toolPresentation } from "./presentation.js";

const presentationIds = ["ui.diffs", "ui.read", "ui.search", "ui.terminal"];

test("Codemode offers compact and detailed UI choices with a compact default", () => {
  const preference = AGENT_IDE_PREFERENCES.find((item) => item.id === "ui.codemode");
  expect(preference).toMatchObject({ kind: "choice", group: "ui", default: "compact" });
  if (preference?.kind !== "choice") throw new Error("Missing Codemode choice");
  expect(preference.values).toEqual([
    { value: "compact", label: "Compact" },
    { value: "full", label: "Detailed" },
  ]);
});

test("tool presentation choices are available in UI settings with compact defaults", () => {
  const preferences = presentationIds.map((id) =>
    AGENT_IDE_PREFERENCES.find((preference) => preference.id === id),
  );

  expect(preferences).toHaveLength(4);
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
