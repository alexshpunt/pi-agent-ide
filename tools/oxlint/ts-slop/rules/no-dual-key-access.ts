import type { ESTree } from "@oxlint/plugins";

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : null;
}

function normalize(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function unwrapChain(node: ESTree.Node): ESTree.Node {
  return node.type === "ChainExpression" ? node.expression : node;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow falling back between snake_case and camelCase spellings of the same field on the same object.",
    },
    messages: {
      dualKeyAccess:
        "Falling back between `{{left}}` and `{{right}}` — same field, two spellings. Normalize the object shape once instead of checking both.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      LogicalExpression(node) {
        if (node.operator !== "??" && node.operator !== "||") return;
        const left = unwrapChain(node.left);
        const right = unwrapChain(node.right);
        if (left.type !== "MemberExpression") return;
        if (right.type !== "MemberExpression") return;

        const leftName = propertyName(left);
        const rightName = propertyName(right);
        if (!leftName || !rightName || leftName === rightName) return;
        if (normalize(leftName) !== normalize(rightName)) return;

        // A call expression as the base object (e.g. `getUsage()?.input_tokens`)
        // may not be referentially the same call on both sides even when the
        // source text matches — skip rather than risk a false positive from a
        // side-effecting call being read as pure.
        if (left.object.type === "CallExpression" || right.object.type === "CallExpression") {
          return;
        }

        if (sourceCode.getText(left.object) !== sourceCode.getText(right.object)) return;

        context.report({
          node,
          messageId: "dualKeyAccess",
          data: { left: leftName, right: rightName },
        });
      },
    };
  },
};
