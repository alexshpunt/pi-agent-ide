import { describe, expect, test } from "vitest";

import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
import { disabledByPreset } from "./presets.js";
import { selectBuiltinExtensions } from "./selection.js";

describe("built-in extension catalog", () => {
  test("does not register removed editing restrictions", () => {
    const ids = BUILTIN_EXTENSIONS.map((extension) => extension.id);
    expect(ids).not.toContain("editor.argument-order");
    expect(ids).not.toContain("editor.overwrite");
    expect(ids).toContain("editor.stale-anchor");
  });

  test("keeps terminal sessions independently selectable and enabled by default", () => {
    const terminal = BUILTIN_EXTENSIONS.find((extension) => extension.id === "ide.terminal");
    expect(terminal?.defaultEnabled).not.toBe(false);
    expect(selectBuiltinExtensions(BUILTIN_EXTENSIONS, ["ide.terminal"]).disabled).toContain(
      "ide.terminal",
    );
  });
  test("text editor preset keeps text editing modules and disables IDE extras", () => {
    const disabled = new Set(disabledByPreset(BUILTIN_EXTENSIONS, "text-editor"));

    expect(disabled).not.toContain("read.core");
    expect(disabled).not.toContain("read.filesystem");
    expect(disabled).not.toContain("read.filesystem.text");
    expect(disabled).not.toContain("search.text");
    expect(disabled).not.toContain("editor.core");
    expect(disabled).not.toContain("editor.anchor.exact");
    expect(disabled).not.toContain("ide.ast");

    expect(disabled).toContain("ide.terminal");
    expect(disabled).toContain("ide.debugger");
    expect(disabled).toContain("ide.vision");
    expect(disabled).toContain("ide.diagnostics");
    expect(disabled).toContain("ide.lsp");
    expect(disabledByPreset(BUILTIN_EXTENSIONS, "full")).toEqual([]);
  });

  test("independent leaf disabled combinations can be selected", () => {
    const ids = BUILTIN_EXTENSIONS.map((extension) => extension.id);
    const dependencyIds = new Set(
      BUILTIN_EXTENSIONS.flatMap((extension) => extension.dependencies),
    );
    const leafIds = ids.filter((id) => !dependencyIds.has(id));
    const combinations = [
      [],
      ...leafIds.map((id) => [id]),
      ...leafIds.flatMap((first, firstIndex) =>
        leafIds.slice(firstIndex + 1).map((second) => [first, second]),
      ),
    ];

    for (const disabled of combinations) {
      const result = selectBuiltinExtensions(BUILTIN_EXTENSIONS, disabled);
      for (const extension of result.enabled) {
        expect(extension.dependencies.every((dependency) => !result.disabled.has(dependency))).toBe(
          true,
        );
      }
    }
  });
  test("enables the built-in extensions by default", () => {
    expect(BUILTIN_EXTENSIONS.every((extension) => extension.defaultEnabled !== false)).toBe(true);
  });
});
