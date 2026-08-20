import type { ESTree } from "@oxlint/plugins";

function isSortCall(node: ESTree.Node): boolean {
  if (node.type !== "CallExpression") return false;
  if (node.callee.type !== "MemberExpression") return false;
  if (node.callee.property.type !== "Identifier") return false;
  return node.callee.property.name === "sort";
}

function isZero(node: ESTree.Node | null | undefined): boolean {
  return node?.type === "Literal" && node.value === 0;
}

function isOne(node: ESTree.Node | null | undefined): boolean {
  return node?.type === "Literal" && node.value === 1;
}

function isNegativeOne(node: ESTree.Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "Literal") return node.value === -1;
  return (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal" &&
    node.argument.value === 1
  );
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow sorting a whole array just to pluck one extreme element — use `Math.min`/`Math.max` or a single pass instead.",
    },
    messages: {
      sortForExtremum:
        "Sorting the whole array to get one element is O(n log n) — use `Math.min`/`Math.max` (or a single reduce pass) instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.type !== "Identifier") return;
        if (!isSortCall(node.callee.object)) return;

        const method = node.callee.property.name;

        if ((method === "pop" || method === "shift") && node.arguments.length === 0) {
          context.report({ node, messageId: "sortForExtremum" });
          return;
        }

        if (method === "slice") {
          if (
            (node.arguments.length === 2 &&
              isZero(node.arguments[0]) &&
              isOne(node.arguments[1])) ||
            (node.arguments.length === 1 && isNegativeOne(node.arguments[0]))
          ) {
            context.report({ node, messageId: "sortForExtremum" });
          }
          return;
        }

        if (method === "at" && node.arguments.length === 1) {
          if (isZero(node.arguments[0]) || isNegativeOne(node.arguments[0])) {
            context.report({ node, messageId: "sortForExtremum" });
          }
        }
      },
      MemberExpression(node) {
        if (!node.computed) return;
        if (!isZero(node.property) && !isNegativeOne(node.property)) return;
        if (isSortCall(node.object)) {
          context.report({ node, messageId: "sortForExtremum" });
        }
      },
    };
  },
};
