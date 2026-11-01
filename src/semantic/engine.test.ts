import { expect, test } from "vitest";
import { semanticEngine } from "./engine.js";

test("the selected semantic engine defaults to ColGREP and rejects unsupported settings", () => {
  expect(semanticEngine(undefined)).toBe("colgrep");
  expect(semanticEngine("colgrep")).toBe("colgrep");
  expect(semanticEngine("vera")).toBe("vera");
  expect(() => semanticEngine("other")).toThrow(Error);
});
