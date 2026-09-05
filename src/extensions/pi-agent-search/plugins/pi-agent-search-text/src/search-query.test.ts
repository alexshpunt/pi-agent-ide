import { describe, expect, test } from "vitest";

import { compileSearchFallbackQuery, compileSearchQuery } from "#src/search-query.js";

function expressionFor(query: string): RegExp {
  return new RegExp(compileSearchQuery(query).replace("\\K", ""), "u");
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

  test("uses implicit AND between adjacent terms in a Boolean query", () => {
    const expression = expressionFor("alpha beta OR gamma");

    expect(expression.test("alpha beta")).toBe(true);
    expect(expression.test("alpha")).toBe(false);
    expect(expression.test("gamma")).toBe(true);
  });

  test("matches single- and double-quoted phrases without requiring an operator", () => {
    const singleQuoted = expressionFor("'switch session'");
    const doubleQuoted = expressionFor('"cross repo"');

    expect(singleQuoted.test("switch session now")).toBe(true);
    expect(singleQuoted.test("switch another session")).toBe(false);
    expect(doubleQuoted.test("cross repo move")).toBe(true);
    expect(doubleQuoted.test("cross another repo")).toBe(false);
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
    ["foo OR", "Invalid Boolean search query at column 7: expected a term after OR."],
    ["foo AND (bar OR baz", "Invalid Boolean search query at column 20: expected ')'."],
    ["foo OR ()", "Invalid Boolean search query at column 9: expected a term after '('."],
    ["foo NOT", "Invalid Boolean search query at column 8: expected a term after NOT."],
    ["OR foo", "Invalid Boolean search query at column 1: expected a term before OR."],
    ['foo OR "bar', "Invalid Boolean search query at column 8: unterminated double-quoted term."],
    ["foo OR bar)", "Invalid Boolean search query at column 11: unexpected ')'."],
  ])("reports an actionable error for %s", (query, message) => {
    expect(() => compileSearchQuery(query)).toThrow(message);
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

  test.each(["single", "alpha OR beta", "alpha | beta"])(
    "does not provide fallback for %s",
    (query) => {
      expect(compileSearchFallbackQuery(query)).toBeUndefined();
    },
  );
});
