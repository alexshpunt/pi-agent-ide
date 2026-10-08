import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const textMatchers = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toContainEqual",
  "toMatch",
  "toMatchObject",
  "toThrow",
  "toThrowError",
  "toMatchInlineSnapshot",
  "toMatchSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  "toThrowErrorMatchingSnapshot",
]);
const modifiers = new Set(["not", "resolves", "rejects"]);
const predicates = new Set(["includes", "startsWith", "endsWith"]);
const promptGetters = new Set(["getSystemPrompt", "getProviderSystemPrompt"]);
const promptProperties = new Set(["systemPrompt", "promptGuidelines", "promptSnippet"]);

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  switch (node.type) {
    case "AwaitExpression": {
      return unwrap(node.argument);
    }
    case "ChainExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression": {
      return unwrap(node.expression);
    }
    default: {
      return node;
    }
  }
}

function variableFor(source: SourceCode, node: ESTree.Node): Variable | null {
  if (node.type !== "Identifier") return null;
  let scope: Scope | null = source.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function isExpect(source: SourceCode, node: ESTree.Node): boolean {
  if (node.type !== "Identifier") return false;
  const variable = variableFor(source, node);
  if (variable === null || variable.defs.length === 0) return node.name === "expect";
  return variable.defs.some(
    (definition) =>
      definition.type === "ImportBinding" &&
      definition.parent?.type === "ImportDeclaration" &&
      (definition.parent.source.value === "vitest" ||
        definition.parent.source.value === "@jest/globals") &&
      importedName(definition.node) === "expect",
  );
}

function initializer(source: SourceCode, node: ESTree.Node): ESTree.Node | null {
  const variable = variableFor(source, node);
  if (
    variable === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return null;
  }
  for (const definition of variable.defs) {
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.parent?.type === "VariableDeclaration" &&
      definition.parent.kind === "const"
    ) {
      return definition.node.init;
    }
  }
  return null;
}

function isPromptSource(
  source: SourceCode,
  input: ESTree.Node,
  seen = new Set<ESTree.Node>(),
): boolean {
  const node = unwrap(input);
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    const init = initializer(source, node);
    return init !== null && isPromptSource(source, init, seen);
  }
  if (node.type === "MemberExpression") return promptProperties.has(propertyName(node) ?? "");
  if (node.type !== "CallExpression") return false;
  const callee = unwrap(node.callee);
  if (callee.type !== "Identifier") return false;
  const variable = variableFor(source, callee);
  const name =
    variable?.defs
      .map((definition) => importedName(definition.node))
      .find((value) => value !== null) ?? callee.name;
  if (promptGetters.has(name)) return true;
  if (name !== "readFile" && name !== "readFileSync") return false;
  const path = node.arguments[0];
  return (
    path !== undefined &&
    /(?:AGENTS|CLAUDE|SKILL)\.md|["'`]([^"'`]*\/)?(?:docs|guides|prompts)\//u.test(
      source.getText(path),
    )
  );
}

function stringParts(input: ESTree.Node): string[] {
  const node = unwrap(input);
  switch (node.type) {
    case "Literal": {
      if (typeof node.value === "string") return [node.value];
      return "regex" in node ? [node.regex.pattern] : [];
    }
    case "TemplateLiteral": {
      return [node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(" ")];
    }
    case "ObjectExpression": {
      return node.properties.flatMap((property) =>
        property.type === "Property" ? stringParts(property.value) : [],
      );
    }
    case "ArrayExpression": {
      return node.elements.flatMap((element) => (element === null ? [] : stringParts(element)));
    }
    case "BinaryExpression": {
      return node.operator === "+" ? [...stringParts(node.left), ...stringParts(node.right)] : [];
    }
    default: {
      return [];
    }
  }
}

function looksLikeProse(text: string): boolean {
  // Exclude obvious syntax; this is an audit heuristic, not a language classifier.
  if (/```|(?:declare|import|export)\s|[{};]|"[^"\n]+"\s*:/u.test(text)) return false;
  return (
    /\p{L}{2,}(?:[\s]+\p{L}{2,}){2}/u.test(text) ||
    /\p{L}{2,}[\s]+\p{L}{2,}[.!?](?:\s|$)/u.test(text)
  );
}

function expectCall(
  source: SourceCode,
  member: ESTree.MemberExpression,
): ESTree.CallExpression | null {
  let node = unwrap(member.object);
  while (node.type === "MemberExpression" && modifiers.has(propertyName(node) ?? "")) {
    node = unwrap(node.object);
  }
  return node.type === "CallExpression" && isExpect(source, node.callee) ? node : null;
}

/** Find prompt assertions and broader prose candidates for a separate, manual lint audit. No fixes. */
export const noProseAssertionsRule = defineRule({
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      promptSource:
        "Prompt/document text assertion: check observable behavior instead of instruction wording.",
      wordingCandidate:
        "Prose wording candidate: review whether exact text is really the contract.",
    },
  },
  create(context) {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(context.filename)) return {};
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== "MemberExpression") return;
        const matcher = propertyName(callee);
        if (matcher === null) return;
        const assertion = expectCall(source, callee);
        const actual = assertion?.arguments[0];
        if (actual === undefined) return;
        let subject: ESTree.Node = actual;
        let expected: ESTree.Node | undefined = node.arguments[0];
        const value = unwrap(actual);
        if (value.type === "CallExpression" && value.callee.type === "MemberExpression") {
          const predicate = propertyName(value.callee);
          if (predicates.has(predicate ?? "")) {
            subject = value.callee.object;
            expected = value.arguments[0];
          } else if (
            predicate === "test" &&
            value.callee.object.type === "Literal" &&
            "regex" in value.callee.object
          ) {
            subject = value.arguments[0] ?? actual;
            expected = value.callee.object;
          } else if (!textMatchers.has(matcher)) return;
        } else if (!textMatchers.has(matcher)) return;

        const prompt = isPromptSource(source, subject);
        if (expected === undefined) {
          if (prompt && matcher.includes("Snapshot"))
            context.report({ node, messageId: "promptSource" });
          return;
        }
        const parts = stringParts(expected);
        if (prompt) {
          const init = initializer(source, expected);
          const knownParts = parts.length > 0 ? parts : init === null ? [] : stringParts(init);
          if (knownParts.length > 0) context.report({ node, messageId: "promptSource" });
        } else if (parts.some(looksLikeProse)) {
          context.report({ node, messageId: "wordingCandidate" });
        }
      },
    };
  },
});
