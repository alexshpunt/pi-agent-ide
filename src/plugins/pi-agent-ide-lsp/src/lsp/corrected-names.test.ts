import { expect, test, vi } from "vitest";
import {
  isFatalClangError,
  positionKey,
  textInRange,
  withinTypoDistance,
  withoutCorrectedNames,
  type DocumentErrors,
  type ReportedName,
} from "./corrected-names.ts";

const at = (line: number, character: number, text: string, uri = "file:///main.cpp") =>
  ({ uri, start: { line, character }, text }) satisfies ReportedName;
const errors = (starts: [number, number][], stopped = false): DocumentErrors => ({
  starts: new Set(starts.map(([line, character]) => positionKey({ line, character }))),
  stopped,
  fatal: [],
});
const keep = (
  items: ReportedName[],
  names: string[],
  errorsOf: (uri: string) => Promise<DocumentErrors | undefined>,
) => withoutCorrectedNames(items, (item) => item, names, errorsOf);

test("places that write the name are kept without reading diagnostics", async () => {
  const errorsOf = vi.fn(async () => errors([[3, 2]]));
  const items = [at(0, 5, "call_normalize_routine"), at(3, 2, "call_normalize_routine")];
  expect(await keep(items, ["call_normalize_routine"], errorsOf)).toEqual(items);
  expect(errorsOf).not.toHaveBeenCalled();
});

test("a corrected misspelling with an error at its start is dropped", async () => {
  const items = [at(0, 5, "call_normalize_routine"), at(2, 2, "FuncCallNormalizeRoutine")];
  expect(await keep(items, ["call_normalize_routine"], async () => errors([[2, 2]]))).toEqual([
    items[0],
  ]);
});

test("other text without an error stays listed", async () => {
  // A constructor call at a variable, a destructor, an operator and a macro use.
  const items = [at(5, 9, "item"), at(6, 2, "~"), at(7, 4, "+"), at(8, 2, "CALL")];
  expect(await keep(items, ["Widget"], async () => errors([[9, 0]]))).toEqual(items);
});

test("parts of an operator name count as the name", async () => {
  const items = [at(4, 14, "new")];
  expect(await keep(items, ["operator new"], async () => errors([[4, 14]]))).toEqual(items);
});

test("after the error limit a place within the typo distance is dropped without its own error", async () => {
  const items = [at(21, 2, "FuncCallNormalizeRoutine"), at(5, 9, "item")];
  expect(
    await keep(items, ["call_normalize_routine", "Widget"], async () => errors([], true)),
  ).toEqual([items[1]]);
});

test("places are kept when diagnostics are unavailable", async () => {
  const items = [at(2, 2, "FuncCallNormalizeRoutine")];
  expect(await keep(items, ["call_normalize_routine"], async () => undefined)).toEqual(items);
});

test("the typo distance follows clang's bound of a third of the typo", () => {
  expect(withinTypoDistance("FuncCallNormalizeRoutine", "call_normalize_routine")).toBe(true);
  expect(withinTypoDistance("call_targte", "call_target")).toBe(true);
  expect(withinTypoDistance("item", "Widget")).toBe(false);
  expect(withinTypoDistance("Obsolete", "ObsoleteAttribute")).toBe(false);
});

test("range text spans lines and rejects ranges outside the content", () => {
  const content = "first\nsecond line\n";
  expect(
    textInRange(content, { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }),
  ).toBe("second");
  expect(
    textInRange(content, { start: { line: 0, character: 2 }, end: { line: 1, character: 3 } }),
  ).toBe("rst\nsec");
  expect(
    textInRange(content, { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }),
  ).toBe("");
});

test("fatal clang errors include the error limit and files that cannot be read", () => {
  expect(isFatalClangError("fatal_too_many_errors", "Too many errors emitted, stopping now")).toBe(
    true,
  );
  expect(isFatalClangError("pp_file_not_found", "'missing.h' file not found")).toBe(true);
  expect(isFatalClangError("err_module_not_found", "module 'm' not found")).toBe(true);
  expect(isFatalClangError("LSP", "too many errors emitted, stopping now")).toBe(true);
  expect(isFatalClangError("undeclared_var_use_suggest", "Use of undeclared identifier 'x'")).toBe(
    false,
  );
});
