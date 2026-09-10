import { expect, test } from "vitest";
import { formatApplySource } from "#src/core/apply/format-source.js";

test("display formatting expands compact code and leaves invalid input intact", async () => {
  const source = 'try{read({path:"x"})}catch(e){result({code:e.code})}';
  const formatted = await formatApplySource(source);
  expect(formatted.split("\n").length).toBeGreaterThan(3);
  expect(formatted).not.toBe(source);
  const invalid = "const x = {";
  expect(await formatApplySource(invalid)).toBe(invalid);
});
