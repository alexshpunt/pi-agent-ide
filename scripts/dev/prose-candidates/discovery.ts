import { createHash } from "node:crypto";
import ts from "typescript";

/** One static test declaration; parameter tables are not expanded or executed. */
export interface TestDeclaration {
  id: string;
  file: string;
  kind: "unit" | "integration";
  name: string;
  line: number;
  endLine: number;
  declaration: string;
  callback: string;
  sourceHash: string;
}

/** A discovered file or declaration that cannot be safely classified from static source. */
export interface DiscoveryIssue {
  file: string;
  line: number;
  reason: string;
}

/** Hash the complete context so source changes invalidate saved classifications and reviews. */
export function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function rootOf(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression) ||
    ts.isCallExpression(expression)
  )
    return rootOf(expression.expression);
  if (ts.isTaggedTemplateExpression(expression)) return rootOf(expression.tag);
  return undefined;
}

function importOwner(node: ts.Node): ts.ImportDeclaration | undefined {
  if (ts.isImportDeclaration(node)) return node;
  return ts.isSourceFile(node) ? undefined : importOwner(node.parent);
}

/** Extract tests by framework binding, including aliases, without inspecting assertion wording. */
export function extractTests(fileName: string, source: string) {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    allowJs: true,
    target: ts.ScriptTarget.Latest,
  };
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? file : undefined);
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const tests: TestDeclaration[] = [];
  const issues: DiscoveryIssue[] = [];
  const syntax = program.getSyntacticDiagnostics(file);
  if (syntax.length)
    return {
      tests,
      issues: [{ file: fileName, line: 1, reason: "Test source has syntax errors." }],
    };
  if (source.length > 60_000)
    return {
      tests,
      issues: [
        {
          file: fileName,
          line: 1,
          reason: "Test source exceeds the 60,000-character context bound.",
        },
      ],
    };

  function isTest(expression: ts.Expression): boolean {
    const root = rootOf(expression);
    if (!root) return false;
    const symbol = checker.getSymbolAtLocation(root);
    const declarations = symbol?.declarations ?? [];
    if (!symbol) return root.text === "test" || root.text === "it";
    return declarations.some((declaration) => {
      const owner = importOwner(declaration);
      if (
        !owner ||
        !ts.isStringLiteral(owner.moduleSpecifier) ||
        !["vitest", "@jest/globals", "node:test"].includes(owner.moduleSpecifier.text)
      )
        return false;
      if (ts.isImportSpecifier(declaration))
        return ["test", "it"].includes((declaration.propertyName ?? declaration.name).text);
      if (ts.isImportClause(declaration)) return owner.moduleSpecifier.text === "node:test";
      if (ts.isNamespaceImport(declaration)) {
        const member = root.parent;
        if (ts.isPropertyAccessExpression(member)) return ["test", "it"].includes(member.name.text);
        if (ts.isElementAccessExpression(member) && ts.isStringLiteral(member.argumentExpression))
          return ["test", "it"].includes(member.argumentExpression.text);
      }
      return false;
    });
  }
  function callbackOf(expression: ts.Expression | undefined) {
    if (!expression) return undefined;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    for (const declaration of checker.getSymbolAtLocation(expression)?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      )
        return declaration.initializer;
    }
    return undefined;
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && isTest(node.expression)) {
      const factory =
        ((ts.isCallExpression(node.parent) ||
          ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node) ||
        ts.isTaggedTemplateExpression(node.parent);
      if (!factory) {
        const callback = node.arguments
          .slice(1)
          .map(callbackOf)
          .find((value) => value !== undefined);
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        if (!callback)
          issues.push({
            file: fileName,
            line,
            reason: "Test has no statically resolvable callback (including todo declarations).",
          });
        else
          tests.push({
            id: sourceHash(fileName + ":" + node.getStart(file) + ":" + node.getText(file)).slice(
              0,
              20,
            ),
            file: fileName,
            kind:
              fileName.includes("/integration/") || fileName.includes(".integration.test.")
                ? "integration"
                : "unit",
            name: node.arguments[0]?.getText(file) ?? "(unnamed)",
            line,
            endLine: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            declaration: node.getText(file),
            callback: callback.getText(file),
            sourceHash: sourceHash(source),
          });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!tests.length && !issues.length)
    issues.push({
      file: fileName,
      line: 1,
      reason:
        "No supported static test declarations found; wrappers or another framework may need manual inspection.",
    });
  return { tests, issues };
}
