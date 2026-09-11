import { describe, expect, test } from "vitest";

import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
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
  test("enables the built-in extensions by default", () => {
    expect(BUILTIN_EXTENSIONS.every((extension) => extension.defaultEnabled !== false)).toBe(true);
  });
});
