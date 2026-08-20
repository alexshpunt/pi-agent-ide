import type { ESTree } from "@oxlint/plugins";

function isIdentityArrow(node: ESTree.Node): boolean {
  if (node.type !== "ArrowFunctionExpression") return false;
  if (node.params.length !== 1) return false;
  const param = node.params[0];
  if (param.type !== "Identifier") return false;

  if (node.body.type === "Identifier" && node.body.name === param.name) {
    return true;
  }

  if (node.body.type === "BlockStatement") {
    if (node.body.body.length === 1) {
      const stmt = node.body.body[0];
      if (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "Identifier" &&
        stmt.argument.name === param.name
      ) {
        return true;
      }
    }
  }
  return false;
}

const IDENTITY_METHODS = new Set(["map", "flatMap", "filter", "forEach", "every", "some", "find"]);

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow identity callbacks in array methods like `.map(x => x)` — the call is a no-op.",
    },
    messages: {
      identity: "`.{{method}}(x => x)` is an identity passthrough — remove the call.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.type !== "Identifier") return;
        const method = node.callee.property.name;
        if (!IDENTITY_METHODS.has(method)) return;
        if (node.arguments.length !== 1) return;
        if (isIdentityArrow(node.arguments[0])) {
          context.report({
            node,
            messageId: "identity",
            data: { method },
          });
        }
      },
    };
  },
};
