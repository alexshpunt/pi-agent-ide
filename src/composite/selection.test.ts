import { describe, expect, test, vi } from "vitest";

import { type BuiltinExtension, selectBuiltinExtensions } from "./selection.js";

const extensions: readonly BuiltinExtension[] = [
  extension("core"),
  extension("plugin", ["core"]),
  extension("feature", ["plugin"]),
  extension("independent"),
];

describe("built-in extension selection", () => {
  test("keeps every extension enabled by default", () => {
    expect(selectBuiltinExtensions(extensions, []).enabled.map(({ id }) => id)).toEqual([
      "core",
      "plugin",
      "feature",
      "independent",
    ]);
  });

  test("cascades disabled dependencies", () => {
    const selection = selectBuiltinExtensions(extensions, ["core"]);

    expect([...selection.disabled]).toEqual(["core", "plugin", "feature"]);
    expect(selection.enabled.map(({ id }) => id)).toEqual(["independent"]);
  });

  test("rejects unknown configured IDs", () => {
    expect(() => selectBuiltinExtensions(extensions, ["missing"])).toThrow(
      "Unknown Pi Agent IDE extension ID in disabledExtensions: missing",
    );
  });
});

function extension(id: string, dependencies: readonly string[] = []): BuiltinExtension {
  return { id, dependencies, register: vi.fn() };
}
