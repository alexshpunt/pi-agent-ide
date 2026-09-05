import { describe, expect, test } from "vitest";

import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";

describe("built-in extension catalog", () => {
  test("marks the opt-in editor plugins as off by default", () => {
    const byId = new Map(BUILTIN_EXTENSIONS.map((extension) => [extension.id, extension]));

    expect(byId.get("editor.argument-order")?.defaultEnabled).toBe(false);
    expect(byId.get("editor.overwrite")?.defaultEnabled).toBe(false);
  });

  test("keeps every other built-in enabled by default", () => {
    const defaultOff = BUILTIN_EXTENSIONS.filter(
      (extension) => extension.defaultEnabled === false,
    ).map((extension) => extension.id);

    expect(defaultOff).toEqual(["editor.argument-order", "editor.overwrite"]);
  });
});
