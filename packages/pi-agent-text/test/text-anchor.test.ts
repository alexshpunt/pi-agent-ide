import { describe, expect, test } from "vitest";

import { isTextAnchorResolutionAttempt, isTextAnchorResolver, TextAnchor } from "#src/index.js";

class FixtureTextAnchor extends TextAnchor {
  public constructor(value: string, lineNumber: number) {
    super(value, lineNumber);
  }
}
describe("text anchor runtime contracts", () => {
  test("accepts structural resolvers and all fulfilled attempt kinds", () => {
    expect(
      isTextAnchorResolver({
        id: "fixture",
        description: "Fixture anchors.",
        renderFull: (value: string): string => value,
        renderCompact: (value: string): string => value,
        tryResolve: () => Promise.resolve({ kind: "not-handled" }),
      }),
    ).toBe(true);
    expect(isTextAnchorResolutionAttempt({ kind: "not-handled" })).toBe(true);
    expect(
      isTextAnchorResolutionAttempt({
        kind: "resolved",
        anchor: new FixtureTextAnchor("fixture", 2),
      }),
    ).toBe(true);
    expect(isTextAnchorResolutionAttempt({ kind: "failed", error: new Error("failed") })).toBe(
      true,
    );
  });

  test("accepts a whitespace-only exact anchor value", () => {
    expect(() => new FixtureTextAnchor("  \n\t", 1)).not.toThrow();
  });

  test("rejects malformed resolver and attempt values", () => {
    expect(isTextAnchorResolver({ id: "fixture", description: "Missing callback." })).toBe(false);
    expect(
      isTextAnchorResolver({
        id: "fixture",
        description: "Malformed recovery callback.",
        tryResolve: () => Promise.resolve({ kind: "not-handled" }),
        recover: "not a function",
      }),
    ).toBe(false);
    expect(
      isTextAnchorResolutionAttempt({
        kind: "resolved",
        anchor: { value: "fixture", lineNumber: 2 },
      }),
    ).toBe(false);
    expect(isTextAnchorResolutionAttempt({ kind: "failed" })).toBe(false);

    const throwingValue = Object.defineProperty({}, "kind", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() => isTextAnchorResolutionAttempt(throwingValue)).not.toThrow();
    expect(isTextAnchorResolutionAttempt(throwingValue)).toBe(false);
  });
});
