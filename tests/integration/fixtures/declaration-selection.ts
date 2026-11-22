import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Interpolate real issued IDs into deterministic assistant messages before tool validation. */
export default function declarationSelection(pi: ExtensionAPI): void {
  const selections = new Map<string, { declaration?: string; name?: string }>();
  pi.on("tool_result", (event) => {
    if (event.toolName !== "lsp_search" || typeof event.input.declaration !== "string") return;
    const output = event.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("\n");
    selections.set(event.input.declaration, {
      declaration: /SEARCH#[^\s]+:1:match/u.exec(output)?.[0],
      name: /capture name: (RESULT#[^\s]+)/u.exec(output)?.[1],
    });
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    return {
      message: {
        ...event.message,
        content: event.message.content.map((block) => {
          if (block.type !== "toolCall") return block;
          const input = block.arguments;
          const reference = typeof input.path === "object" && input.path !== null
            ? (input.path as { id?: unknown }).id : input.path;
          if (typeof reference !== "string" || !reference.startsWith("fixture:declaration:")) return block;
          const kind = reference.endsWith("#name") ? "name" : "declaration";
          const declaration = reference.slice("fixture:declaration:".length).replace(/#name$/u, "");
          const selected = selections.get(declaration)?.[kind];
          if (selected === undefined) throw new Error(`Missing issued ${kind} selection for ${block.id}`);
          return { ...block, arguments: { ...input, path: typeof input.path === "object" ? { id: selected.replace(/^RESULT#/u, "") } : selected } };
        }),
      },
    };
  });
}
