import type { ESTree } from "@oxlint/plugins";

function isReturnBoolean(node: ESTree.Statement): boolean {
  return (
    node.type === "ReturnStatement" &&
    node.argument != null &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "boolean"
  );
}

function unwrapBlock(node: ESTree.Statement): ESTree.Statement | undefined {
  if (node.type === "BlockStatement") {
    return node.body.length === 1 ? node.body[0] : undefined;
  }
  return node;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `if (x) return true; else return false;` — use the condition directly.",
    },
    messages: {
      redundant: "Redundant boolean if — return the condition directly (or its negation).",
    },
    schema: [],
  },
  create(context) {
    return {
      IfStatement(node) {
        if (!node.alternate) return;
        const consequent = unwrapBlock(node.consequent);
        const alternate = unwrapBlock(node.alternate);
        if (!consequent || !alternate) return;
        if (isReturnBoolean(consequent) && isReturnBoolean(alternate)) {
          context.report({ node, messageId: "redundant" });
        }
      },
    };
  },
};
