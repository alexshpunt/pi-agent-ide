import { expect, test } from "vitest";
import { parseDocument } from "./manager.js";
import { isSupportedOutlinePath } from "./outline.js";

test.each([".cc", ".hh", ".hxx"])(
  "parses and enables outlines for C++ %s files",
  async (extension) => {
    const file = `main${extension}`;
    expect(isSupportedOutlinePath(file)).toBe(true);
    const tree = await parseDocument(file, process.cwd(), ["int main() { return 0; }"]);
    expect(tree).toBeDefined();
  },
);
