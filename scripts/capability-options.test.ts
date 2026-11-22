import { describe, expect, test } from "vitest";
import { parseArguments } from "#capabilities/options.ts";

const valueOptions = [
  "--model",
  "--case",
  "--mode",
  "--attempts",
  "--concurrency",
  "--timeout",
  "--results",
  "--pi",
  "--auth-dir",
  "--connector",
  "--connector-root",
  "--claude-state",
  "--claude-executable",
];

describe("capability CLI arguments", () => {
  test.each(valueOptions)("rejects repeated %s values and identifies the option", (option) => {
    for (const second of ["first", "second"]) {
      expect(() => parseArguments([option, "first", "--run", option, second])).toThrow(option);
    }
  });

  test("keeps each single value and default unchanged", () => {
    const input = valueOptions.flatMap((option, index) => [option, `value-${index}`]);
    const { args, value } = parseArguments(input);
    expect(args).toEqual(input);
    for (const [index, option] of valueOptions.entries()) {
      expect(value(option, "fallback")).toBe(`value-${index}`);
    }
    expect(parseArguments([]).value("--case")).toBeUndefined();
    expect(parseArguments([]).value("--case", "fallback")).toBe("fallback");
  });

  test("keeps boolean flags repeatable and strips package-manager separators", () => {
    const { args, value } = parseArguments(["--", "--run", "--run", "--case", "--", "-fixture"]);
    expect(args).toEqual(["--run", "--run", "--case", "-fixture"]);
    expect(value("--case")).toBe("-fixture");
  });

  test.each([["--unknown"], ["--case"], ["--case", ""], ["--case", "--list"]])(
    "rejects unknown or incomplete arguments: %j",
    (...args) => {
      expect(() => parseArguments(args)).toThrow(args[0]);
    },
  );
});
