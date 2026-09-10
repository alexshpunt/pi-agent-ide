import { describe, expect, test } from "vitest";

import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";

describe("built-in extension catalog", () => {
  test("does not register removed editing restrictions", () => {
    const ids = BUILTIN_EXTENSIONS.map((extension) => extension.id);
    expect(ids).not.toContain("editor.argument-order");
    expect(ids).not.toContain("editor.overwrite");
    expect(ids).toContain("editor.stale-anchor");
  });

  test("enables the built-in extensions by default", () => {
    expect(BUILTIN_EXTENSIONS.every((extension) => extension.defaultEnabled !== false)).toBe(true);
  });
});
