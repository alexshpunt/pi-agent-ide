import { fileURLToPath } from "node:url";
import {
  assistantMessage,
  toolCall,
  type PiIntegrationTestOptions,
} from "./pi-runtime/native-pi-coding-agent-test.ts";

/** Static scenarios cannot interpolate random IDs; resolve only explicit fixture placeholders. */
export function withDeclarationSelections(
  options: PiIntegrationTestOptions,
): PiIntegrationTestOptions {
  const issued = new Set<string>();
  return {
    ...options,
    extensions: [
      ...(options.extensions ?? []),
      fileURLToPath(import.meta.resolve("#integration/fixtures/declaration-selection.ts")),
    ],
    tools: Array.isArray(options.tools)
      ? [...new Set([...(options.tools as readonly string[]), "lsp_search"])]
      : options.tools,
    conversation: options.conversation?.flatMap((message) => {
      const declarations = message.blocks.flatMap((block) => {
        if (
          block.type === "toolCall" &&
          block.name === "lsp_search" &&
          typeof block.arguments?.declaration === "string"
        )
          issued.add(block.arguments.declaration);
        if (
          block.type !== "toolCall" ||
          typeof block.arguments?.path !== "string" ||
          !block.arguments.path.startsWith("fixture:declaration:")
        )
          return [];
        const declaration = block.arguments.path
          .slice("fixture:declaration:".length)
          .replace(/#name$/u, "");
        if (issued.has(declaration)) return [];
        issued.add(declaration);
        return [
          assistantMessage(
            [
              toolCall({
                id: `selection-${block.id}`,
                name: "lsp_search",
                arguments: { declaration },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ];
      });
      return [...declarations, message];
    }),
  };
}
