import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noProseAssertionsRule } from "./prose-assertions/rule.js";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const prefix = 'import { expect } from "vitest";\n';
const filename = "example.test.ts";

tester.run("no-prose-assertions", noProseAssertionsRule, {
  valid: [
    { filename, code: `${prefix}expect(result.code).toBe("INVALID_REQUEST");` },
    { filename, code: `${prefix}expect(output).toContain("symbol:file.ts#name");` },
    { filename, code: `${prefix}expect(output).toMatch(/offset=\\d+/u);` },
    { filename, code: `${prefix}expect(output).toContain('"status": "error"');` },
    { filename, code: prefix + 'expect(output).toContain("```ts\\ndeclare const tools: {");' },
    { filename, code: `${prefix}expect(result).toMatchObject({ code: "NOT_FOUND", offset: 2 });` },
    {
      filename,
      code: `${prefix}const input = "Some arbitrary fixture text."; expect(exportText(input)).toContain(input);`,
    },
    {
      filename,
      code: `${prefix}const description = "Some arbitrary fixture text."; expect(wrapped.description).toBe(description);`,
    },
    {
      filename,
      code: `${prefix}expect(getSystemPrompt(run).length).toBeGreaterThan(0);`,
    },
    {
      filename,
      code: `${prefix}function f(expect: (x: unknown) => any) { expect(output).toContain("Some arbitrary fixture text."); }`,
    },
    {
      filename: "example.ts",
      code: `${prefix}expect(output).toContain("Some arbitrary fixture text.");`,
    },
  ],
  invalid: [
    {
      filename,
      name: "an imported prompt getter can be renamed",
      code: `${prefix}import { getSystemPrompt as captured } from "fixture-driver"; expect(captured(run)).toContain("marker");`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      name: "guide reads are audit candidates even when the file may be a fixture",
      code: `${prefix}const guide = await readFile("docs/example.md", "utf8"); expect(guide).toContain("marker");`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      name: "computed matchers still pin text",
      code: `${prefix}expect(output)["toContain"]("Some arbitrary fixture text.");`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      name: "inline snapshots can pin prose",
      code: `${prefix}expect(output).toMatchInlineSnapshot('"Some arbitrary fixture text."');`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      name: "error category phrases need review, not automatic rejection",
      code: `${prefix}expect(() => parse(value)).toThrow("Invalid fixture identifier");`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(getSystemPrompt(run)).toContain("marker");`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}const prompt = getProviderSystemPrompt(run); const alias = prompt; expect(alias).not.toMatch(/fixture words/u);`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: 'import { expect as check } from "vitest"; check(getSystemPrompt(run)).toBe("marker");',
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}await expect(load().systemPrompt).resolves.not.toContain("marker");`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}expect(getSystemPrompt(run)).toMatchSnapshot();`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}const expected = "marker"; expect(getSystemPrompt(run)).toContain(expected);`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}expect(output).toContain("Some arbitrary fixture text.");`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(output).not.toMatch(/Some arbitrary fixture text/u);`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(output).toContain(\`Some arbitrary \${value} fixture text.\`);`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(result).toMatchObject({ message: "Some arbitrary fixture text." });`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(output.includes("Some arbitrary fixture text.")).toBe(true);`,
      errors: [{ messageId: "wordingCandidate" }],
    },
    {
      filename,
      code: `${prefix}expect(/fixture words/u.test(getSystemPrompt(run))).toBe(false);`,
      errors: [{ messageId: "promptSource" }],
    },
    {
      filename,
      code: `${prefix}expect(output).toContain("Произвольный текст для примера.");`,
      errors: [{ messageId: "wordingCandidate" }],
    },
  ],
});
