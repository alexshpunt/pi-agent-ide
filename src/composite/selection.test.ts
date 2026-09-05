import { describe, expect, test, vi } from "vitest";

import { type BuiltinExtension, selectBuiltinExtensions } from "./selection.js";

const extensions: readonly BuiltinExtension[] = [
  extension("core"),
  extension("plugin", ["core"]),
  extension("feature", ["plugin"]),
  extension("independent"),
  experimental("experimental", []),
  experimental("experimental.child", ["experimental"]),
  experimental("experimental.nested", ["experimental.child"]),
];

describe("built-in extension selection", () => {
  test("keeps every extension enabled by default", () => {
    const selection = selectBuiltinExtensions(extensions, [], []);

    expect(selection.enabled.map(({ id }) => id)).toEqual([
      "core",
      "plugin",
      "feature",
      "independent",
    ]);
  });

  test("cascades disabled dependencies", () => {
    const selection = selectBuiltinExtensions(extensions, ["core"], []);

    expect(selection.disabled).toEqual(
      new Set([
        "core",
        "plugin",
        "feature",
        "experimental",
        "experimental.child",
        "experimental.nested",
      ]),
    );
    expect(selection.enabled.map(({ id }) => id)).toEqual(["independent"]);
  });

  test("keeps default-off extensions off without configuration", () => {
    const selection = selectBuiltinExtensions(extensions, [], []);

    expect(selection.disabled.has("experimental")).toBe(true);
    expect(selection.disabled.has("experimental.child")).toBe(true);
  });

  test("turns on a default-off extension listed in enabled", () => {
    const selection = selectBuiltinExtensions(extensions, [], ["experimental"]);

    expect(selection.disabled.has("experimental")).toBe(false);
    expect(selection.enabled.map(({ id }) => id)).toContain("experimental");
  });

  test("turns on default-off dependencies of an enabled extension", () => {
    const selection = selectBuiltinExtensions(extensions, [], ["experimental.child"]);

    expect(selection.disabled.has("experimental")).toBe(false);
    expect(selection.disabled.has("experimental.child")).toBe(false);
    expect(selection.disabled.has("experimental.nested")).toBe(true);
  });

  test("explicit disabled beats explicit enabled", () => {
    const selection = selectBuiltinExtensions(
      extensions,
      ["experimental"],
      ["experimental", "experimental.nested"],
    );

    expect(selection.disabled.has("experimental")).toBe(true);
    expect(selection.disabled.has("experimental.child")).toBe(true);
    expect(selection.disabled.has("experimental.nested")).toBe(true);
  });

  test("cascades default-off state to dependents of an enabled default-off extension", () => {
    // experimental.child depends on experimental; enabling only the child pulls the parent in.
    const selection = selectBuiltinExtensions(extensions, ["experimental.child"], []);

    expect(selection.disabled.has("experimental.child")).toBe(true);
  });

  test("rejects unknown configured IDs", () => {
    expect(() => selectBuiltinExtensions(extensions, ["missing"], [])).toThrow(
      "Unknown Pi Agent IDE extension ID in disabled: missing",
    );
    expect(() => selectBuiltinExtensions(extensions, [], ["missing"])).toThrow(
      "Unknown Pi Agent IDE extension ID in enabled: missing",
    );
  });
});

function extension(id: string, dependencies: readonly string[] = []): BuiltinExtension {
  return { id, dependencies, register: vi.fn() };
}

function experimental(id: string, dependencies: readonly string[] = []): BuiltinExtension {
  return { ...extension(id, dependencies), defaultEnabled: false };
}
