import type { ESTree } from "@oxlint/plugins";

function bodyUsesConcatOrTemplate(body: ESTree.Node, accName: string): boolean {
  if (body.type === "BinaryExpression" && body.operator === "+") {
    if (
      (body.left.type === "Identifier" && body.left.name === accName) ||
      (body.right.type === "Identifier" && body.right.name === accName)
    ) {
      return true;
    }
  }
  if (body.type === "TemplateLiteral") {
    return body.expressions.some((e) => e.type === "Identifier" && e.name === accName);
  }
  return false;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow string concatenation inside `.reduce()` — use `.join()` or build an array instead.",
    },
    messages: {
      stringConcat: "String concatenation in `.reduce()` is O(n²). Use `.map().join()` instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.type !== "Identifier") return;
        if (node.callee.property.name !== "reduce") return;
        if (node.arguments.length < 2) return;

        const init = node.arguments[1];
        const isStringInit =
          (init.type === "Literal" && typeof init.value === "string") ||
          init.type === "TemplateLiteral";
        if (!isStringInit) return;

        const callback = node.arguments[0];
        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
          return;
        }

        const params = callback.params;
        if (params.length < 2) return;

        const accParam = params[0];
        if (accParam.type !== "Identifier") return;

        if (bodyUsesConcatOrTemplate(callback.body, accParam.name)) {
          context.report({ node, messageId: "stringConcat" });
          return;
        }

        if (callback.body.type === "BlockStatement") {
          for (const stmt of callback.body.body) {
            if (
              stmt.type === "ReturnStatement" &&
              stmt.argument &&
              bodyUsesConcatOrTemplate(stmt.argument, accParam.name)
            ) {
              context.report({ node, messageId: "stringConcat" });
              return;
            }
          }
        }
      },
    };
  },
};
