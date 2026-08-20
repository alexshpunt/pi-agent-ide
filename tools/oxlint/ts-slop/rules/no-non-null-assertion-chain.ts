import type { ESTree } from "@oxlint/plugins";

function countChain(node: ESTree.TSNonNullExpression): number {
  let count = 1;
  let current: ESTree.Node = node.expression;

  for (;;) {
    if (current.type === "MemberExpression") {
      current = current.object;
      continue;
    }
    if (current.type === "TSNonNullExpression") {
      count += 1;
      current = current.expression;
      continue;
    }
    break;
  }

  return count;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow chaining multiple non-null assertions (`!`) — narrow the type or guard once instead.",
    },
    messages: {
      chain:
        "Chained non-null assertions (`!`) hide multiple possible null/undefined points — narrow the type or guard once instead.",
    },
    schema: [],
  },
  create(context) {
    const handled = new Set<ESTree.Node>();

    return {
      TSNonNullExpression(node) {
        if (handled.has(node)) return;

        const count = countChain(node);
        if (count < 2) return;

        context.report({ node, messageId: "chain" });

        let current: ESTree.Node = node.expression;
        for (;;) {
          if (current.type === "MemberExpression") {
            current = current.object;
            continue;
          }
          if (current.type === "TSNonNullExpression") {
            handled.add(current);
            current = current.expression;
            continue;
          }
          break;
        }
      },
    };
  },
};
