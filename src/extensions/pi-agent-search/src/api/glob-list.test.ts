import { expect, test } from "vitest";
import { splitGlobList } from "./glob-list.js";

test("keeps commas inside brace alternatives in one glob", () => {
  expect(splitGlobList("**/*.{cmake,txt,h}")).toEqual(["**/*.{cmake,txt,h}"]);
  expect(splitGlobList("src/{a,{b,c}}/*.ts")).toEqual(["src/{a,{b,c}}/*.ts"]);
});

test("splits lists on commas and whitespace outside braces", () => {
  expect(splitGlobList("*.ts, *.{md,txt}  docs/**")).toEqual(["*.ts", "*.{md,txt}", "docs/**"]);
  expect(splitGlobList(" , ")).toEqual([]);
  expect(splitGlobList(undefined)).toEqual([]);
});
