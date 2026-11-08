import { expect, test } from "vitest";
import { withParsedDocument } from "./manager.ts";
import { isSupportedOutlinePath } from "./outline.ts";

test.each([".cc", ".hh", ".hxx"])(
  "parses and enables outlines for C++ %s files",
  async (extension) => {
    const file = `main${extension}`;
    expect(isSupportedOutlinePath(file)).toBe(true);
    const parsed = await withParsedDocument(
      file,
      process.cwd(),
      ["int main() { return 0; }"],
      (tree) => tree !== undefined,
    );
    expect(parsed).toBe(true);
  },
);
