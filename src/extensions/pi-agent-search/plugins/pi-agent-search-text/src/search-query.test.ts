import { describe, expect, test } from "vitest";

import {
  compileSearchFallbackQuery,
  compileSearchQuery,
  compileSearchCondition,
  satisfiesSearchCondition,
} from "#src/search-query.ts";

function expressionFor(query: string) {
  const condition = compileSearchCondition(query);
  return {
    test: (line: string) =>
      condition === undefined
        ? new RegExp(compileSearchQuery(query), "u").test(line)
        : satisfiesSearchCondition(condition, (pattern) => new RegExp(pattern, "u").test(line)),
  };
}

describe("compileSearchQuery", () => {
  test.each([
    "MAX_RESULT_BYTES OR MAX_LOG_CHARS",
    "MAX_RESULT_BYTES | MAX_LOG_CHARS",
    "MAX_RESULT_BYTES||MAX_LOG_CHARS",
  ])("matches OR terms anywhere on a line with %s", (query) => {
    const expression = expressionFor(query);

    expect(expression.test("const MAX_RESULT_BYTES = 1024;")).toBe(true);
    expect(expression.test("const MAX_LOG_CHARS = 4000;")).toBe(true);
    expect(expression.test("const OTHER_LIMIT = 10;")).toBe(false);
  });

  test("treats punctuation and CLI flags as literal Boolean terms", () => {
    const expression = expressionFor("switchSession OR -C OR --config OR +x OR name:value");

    expect(expression.test("await ctx.switchSession(destination)")).toBe(true);
    expect(expression.test("wt -C /repo switch @")).toBe(true);
    expect(expression.test("wt --config custom.toml list")).toBe(true);
    expect(expression.test("enable +x mode")).toBe(true);
    expect(expression.test("name:value")).toBe(true);
    expect(expression.test("unrelated line")).toBe(false);
  });

  test("keeps apostrophes inside bare terms", () => {
    const expression = expressionFor("don't OR stop");

    expect(expression.test("don't retry")).toBe(true);
    expect(expression.test("stop now")).toBe(true);
  });

  test("uses grouping, AND before OR, and infix NOT exclusion", () => {
    const expression = expressionFor("alpha OR (beta AND gamma) NOT ignored");

    expect(expression.test("alpha")).toBe(true);
    expect(expression.test("beta gamma")).toBe(true);
    expect(expression.test("beta")).toBe(false);
    expect(expression.test("beta gamma ignored")).toBe(false);
  });

  test.each([
    ["alpha NOT skip", ["alpha AND NOT skip", "NOT skip AND alpha", "NOT skip alpha"]],
    [
      "alpha beta NOT skip",
      [
        "alpha AND beta AND NOT skip",
        "NOT skip AND alpha AND beta",
        "alpha NOT skip AND beta",
        "alpha AND NOT skip beta",
      ],
    ],
    [
      "(alpha OR gamma) NOT (skip OR drop)",
      ["NOT (skip OR drop) AND (alpha OR gamma)", "(alpha OR gamma) AND NOT (skip OR drop)"],
    ],
  ])("treats a NOT factor anywhere in %s's conjunction alike", (canonical, variants) => {
    const lines = [
      "alpha",
      "alpha beta",
      "gamma beta",
      "alpha beta skip",
      "gamma drop",
      "skip beta",
      "beta",
    ];
    const expected = expressionFor(canonical);
    for (const variant of variants) {
      const expression = expressionFor(variant);
      expect(compileSearchQuery(variant), variant).toBe(compileSearchQuery(canonical));
      expect(
        lines.map((line) => expression.test(line)),
        variant,
      ).toEqual(lines.map((line) => expected.test(line)));
    }
  });

  test("keeps AND NOT inside its OR branch", () => {
    const expression = expressionFor("alpha OR beta AND NOT skip");

    expect(expression.test("alpha skip")).toBe(true);
    expect(expression.test("beta")).toBe(true);
    expect(expression.test("beta skip")).toBe(false);
  });

  test("uses implicit AND between adjacent terms in a Boolean query", () => {
    const expression = expressionFor("alpha beta OR gamma");

    expect(expression.test("alpha beta")).toBe(true);
    expect(expression.test("alpha")).toBe(false);
    expect(expression.test("gamma")).toBe(true);
  });

  test.each([
    '        ("checkout-5", "legacy\u200BCheckout", 3),',
    "'switch session'",
    '"cross repo"',
    'say "hi" twice',
    'open "unterminated',
    "it's 'here",
    'empty ""',
    "call(\"a\", 'b')",
  ])("keeps quotes literal without an operator in %s", (query) => {
    expect(compileSearchCondition(query)).toBeUndefined();
    expect(compileSearchQuery(query, true)).toBe(query);
    expect(new RegExp(compileSearchQuery(query), "u").exec(`x ${query} y`)?.[0]).toBe(query);
  });

  test("groups quoted phrases once an operator is present", () => {
    const expression = expressionFor("\"cross repo\" OR 'switch session'");

    expect(expression.test("cross repo move")).toBe(true);
    expect(expression.test("switch session now")).toBe(true);
    expect(expression.test("cross another repo")).toBe(false);
  });

  test.each([
    ['"a || b"', "a || b"],
    ['"flags | MASK"', "flags | MASK"],
    ['"x AND y"', "x AND y"],
  ])("keeps quoted operator text %s as one literal phrase", (query, text) => {
    const expression = expressionFor(query);

    expect(expression.test(`before ${text} after`)).toBe(true);
    expect(expression.test(`before ${text.replaceAll(" ", "  ")} after`)).toBe(false);
    expect(compileSearchCondition(query)).toMatchObject({ kind: "term" });
  });

  test("combines AND, OR, NOT, and parentheses", () => {
    const expression = expressionFor("(providerError OR errorMessage) AND handled NOT ignored");

    expect(expression.test("const providerError = handled;")).toBe(true);
    expect(expression.test("const errorMessage = handled;")).toBe(true);
    expect(expression.test("const providerError = handledIgnored; // ignored")).toBe(false);
    expect(expression.test("const providerError = pending;")).toBe(false);
  });

  test("keeps a query without Boolean operators literal", () => {
    const words = expressionFor("install package");
    const call = expressionFor("executeInvocation()");

    expect(words.test("pi install package locally")).toBe(true);
    expect(words.test("install one package")).toBe(false);
    expect(call.test("await executeInvocation()")).toBe(true);
    expect(call.test("await executeInvocation(input)")).toBe(false);
  });

  test.each([
    "foo OR",
    "foo AND (bar OR baz",
    "foo OR ()",
    "foo NOT",
    "OR foo",
    "foo AND NOT",
    "foo NOT NOT bar",
    "NOT foo",
    "foo OR NOT bar",
    'foo OR "bar',
    'foo OR ""',
    "foo OR bar)",
  ])("rejects the invalid Boolean query %s", (query) => {
    expect(() => compileSearchQuery(query)).toThrow(SyntaxError);
  });
});

describe("compileSearchFallbackQuery", () => {
  test("matches any whitespace-separated term", () => {
    const fallback = compileSearchFallbackQuery("pi install npm package");
    if (fallback === undefined) {
      throw new Error("Expected a fallback expression");
    }
    const expression = new RegExp(fallback, "u");

    expect(expression.test("configure npm settings")).toBe(true);
    expect(expression.test("install an extension")).toBe(true);
    expect(expression.test("unrelated documentation")).toBe(false);
  });

  test("splits a quoted query without operators at whitespace like any other text", () => {
    const fallback = compileSearchFallbackQuery('"missing" package');
    if (fallback === undefined) throw new Error("Expected a fallback expression");

    expect(new RegExp(fallback, "u").exec("package alone")?.[0]).toBe("package");
  });

  test.each(["single", "alpha OR beta", "alpha | beta", '"a b" OR c', '"a || b"'])(
    "does not provide fallback for %s",
    (query) => {
      expect(compileSearchFallbackQuery(query)).toBeUndefined();
    },
  );
});
