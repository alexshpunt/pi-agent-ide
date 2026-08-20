import type { ESTree } from "@oxlint/plugins";

function isEmptyArray(node: ESTree.Node | undefined): boolean {
  return node?.type === "ArrayExpression" && node.elements.length === 0;
}

const MUTATING_METHODS = new Set(["push", "unshift"]);

function mutatesAcc(stmt: ESTree.Statement, accName: string): boolean {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = stmt.expression;
  if (expr.type !== "CallExpression") return false;
  if (expr.callee.type !== "MemberExpression") return false;
  if (expr.callee.property.type !== "Identifier") return false;
  if (!MUTATING_METHODS.has(expr.callee.property.name)) return false;
  return expr.callee.object.type === "Identifier" && expr.callee.object.name === accName;
}

function returnsIdentifier(stmt: ESTree.Statement, name: string): boolean {
  return (
    stmt.type === "ReturnStatement" &&
    stmt.argument?.type === "Identifier" &&
    stmt.argument.name === name
  );
}

function buildsArrayViaPush(fn: ESTree.Node): boolean {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") {
    return false;
  }
  if (fn.body.type !== "BlockStatement") return false;
  if (fn.params.length === 0 || fn.params[0].type !== "Identifier") return false;

  const accName = fn.params[0].name;
  const statements = fn.body.body;
  if (statements.length === 0) return false;

  const last = statements[statements.length - 1];
  if (!returnsIdentifier(last, accName)) return false;

  const body = statements.slice(0, -1);
  if (body.length === 0) return false;

  // Every remaining statement must be an unconditional push/unshift — a
  // conditional push is filtering, not mapping, and belongs to a different
  // rule. `.every` (not `.some`) is intentional: one non-matching statement
  // means this isn't a pure map-via-reduce.
  return body.every((stmt) => mutatesAcc(stmt, accName));
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow building an array via `.reduce()` push-and-return — use `.map()` instead.",
    },
    messages: {
      reduceAsMap: "Building an array via `.reduce()` — use `.map(...)` instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.type !== "Identifier") return;
        if (node.callee.property.name !== "reduce") return;
        // Exactly 2 args: a reduce without an initial value folds over the
        // array itself, which is a different (non-map) shape — not an
        // oversight to "simplify" away.
        if (node.arguments.length !== 2) return;
        if (!isEmptyArray(node.arguments[1])) return;

        if (buildsArrayViaPush(node.arguments[0])) {
          context.report({ node, messageId: "reduceAsMap" });
        }
      },
    };
  },
};
