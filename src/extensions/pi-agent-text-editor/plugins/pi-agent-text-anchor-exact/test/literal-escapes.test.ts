import { expect, test } from "vitest";
import type { TextAnchorResolverContext } from "pi-agent-text";

import { resolveExactTextAnchor } from "#src/anchor.ts";

const escapes = [
  ["alpha\\nbravo", "alpha\nbravo"],
  ["alpha\\rbravo", "alpha\rbravo"],
  ["alpha\\r\\nbravo", "alpha\r\nbravo"],
  ["alpha\\tbravo", "alpha\tbravo"],
  ["alpha\\n\\tbravo", "alpha\n\tbravo"],
] as const;

function context(
  content: string,
  scope?: TextAnchorResolverContext["scope"],
): TextAnchorResolverContext {
  return {
    source: "fixture.txt",
    content,
    lines: content.split(/\r\n|\r|\n/u),
    cwd: "/project",
    ...(scope === undefined ? {} : { scope }),
  };
}

test.each(escapes)(
  "refuses literal escapes %j and identifies the matching character data",
  (literal, actual) => {
    const result = resolveExactTextAnchor(literal, context(actual));
    expect(result).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
    if (result.kind !== "rejected") throw new Error("Expected rejection");
    // These are fixture values, not the surrounding diagnostic wording.
    expect(result.rejection.reason).toContain(JSON.stringify(literal));
    expect(result.rejection.reason).toContain(JSON.stringify(actual));
    expect(resolveExactTextAnchor(actual, context(actual))).toMatchObject({ kind: "resolved" });
  },
);

test.each(escapes)("keeps matching literal text %j literal", (literal, actual) => {
  expect(resolveExactTextAnchor(literal, context(`${literal}\n${actual}`))).toMatchObject({
    kind: "resolved",
  });
});

test("identifies a decoded match even when it is ambiguous", () => {
  const literal = "alpha\\tbravo";
  const actual = "alpha\tbravo";
  const result = resolveExactTextAnchor(literal, context(`${actual}\n${actual}`));
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
  if (result.kind !== "rejected") throw new Error("Expected rejection");
  expect(result.rejection.reason).toContain(JSON.stringify(actual));
});

test("does not diagnose escapes when the decoded text is absent", () => {
  const actual = "alpha\tbravo";
  const result = resolveExactTextAnchor("alpha\\tbravo", context("unrelated"));
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
  if (result.kind !== "rejected") throw new Error("Expected rejection");
  expect(result.rejection.reason).not.toContain(JSON.stringify(actual));
});

test("checks decoded spans against selection boundaries after CRLF normalization", () => {
  const literal = "alpha\\n\\tbravo";
  const actual = "alpha\n\tbravo";
  const content = `prefix\r\nalpha\r\n\tbravo\r\nsuffix`;
  for (const [endLine, expected] of [
    [3, true],
    [2, false],
  ] as const) {
    const result = resolveExactTextAnchor(
      literal,
      context(content, [
        { start: { lineNumber: 2, column: 0 }, end: { lineNumber: endLine, column: 6 } },
      ]),
    );
    expect(result).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
    if (result.kind !== "rejected") throw new Error("Expected rejection");
    expect(result.rejection.reason.includes(JSON.stringify(actual))).toBe(expected);
  }
});

test("does not interpret escaped backslashes or other escape syntax", () => {
  for (const literal of ["alpha\\\\nbravo", "alpha\\u000abravo", "alpha\\x0abravo"]) {
    const result = resolveExactTextAnchor(literal, context("alpha\nbravo"));
    expect(result).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
    if (result.kind !== "rejected") throw new Error("Expected rejection");
    expect(result.rejection.reason).not.toContain(JSON.stringify("alpha\nbravo"));
  }
});
